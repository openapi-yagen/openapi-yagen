#include "document.h"

#include <algorithm>

#include "ref.h"

using namespace std;

namespace OpenApi {

const vector<Str> httpMethods
    = { "get", "put", "post", "delete", "options", "head", "patch", "trace", "query" };

namespace {
const Str parameterRefPrefix = "#/components/parameters/";
const Str requestBodyRefPrefix = "#/components/requestBodies/";
const Str responseRefPrefix = "#/components/responses/";
const Str headerRefPrefix = "#/components/headers/";
const Str callbackRefPrefix = "#/components/callbacks/";
}

ParameterPtr derefParameter(const Document& doc, const ParameterPtr& parameter)
{
    return derefChain(doc.components.parameters, parameterRefPrefix, parameter);
}

RequestBodyPtr derefRequestBody(const Document& doc, const RequestBodyPtr& requestBody)
{
    return derefChain(doc.components.requestBodies, requestBodyRefPrefix, requestBody);
}

ResponsePtr derefResponse(const Document& doc, const ResponsePtr& response)
{
    return derefChain(doc.components.responses, responseRefPrefix, response);
}

HeaderPtr derefHeader(const Document& doc, const HeaderPtr& header)
{
    return derefChain(doc.components.headers, headerRefPrefix, header);
}

CallbackPtr derefCallback(const Document& doc, const CallbackPtr& callback)
{
    return derefChain(doc.components.callbacks, callbackRefPrefix, callback);
}

namespace {

// Merges path-level and operation-level parameters: operation-level overrides a path-level
// parameter sharing the same (in, name), per the OpenAPI spec, while everything is deref'd so
// callers never see a bare {$ref} parameter.
vector<ParameterPtr> mergeParameters(const Document& doc, const vector<ParameterPtr>& pathParams,
                                     const vector<ParameterPtr>& opParams)
{
    vector<ParameterPtr> result;
    auto upsert = [&](const ParameterPtr& p) {
        auto resolved = derefParameter(doc, p);
        auto it = find_if(result.begin(), result.end(), [&](const ParameterPtr& existing) {
            return existing->in == resolved->in && existing->name == resolved->name;
        });
        if (it != result.end())
            *it = resolved;
        else
            result.push_back(resolved);
    };
    for (const auto& p : pathParams)
        upsert(p);
    for (const auto& p : opParams)
        upsert(p);
    return result;
}

}

namespace {

ResolvedOperation resolveOneOperation(const Document& doc, const Str& method, const Str& path, const PathItem& pathItem,
                                      const Operation& op)
{
    ResolvedOperation resolved;
    resolved.method = method;
    resolved.path = path;
    resolved.operationId = op.operationId;
    resolved.summary = op.summary;
    resolved.description = op.description;
    resolved.tags = op.tags;
    resolved.parameters = mergeParameters(doc, pathItem.parameters, op.parameters);
    resolved.requestBody = op.requestBody ? derefRequestBody(doc, op.requestBody) : nullptr;
    for (const auto& [status, response] : op.responses)
        resolved.responses[status] = derefResponse(doc, response);
    return resolved;
}

}

vector<ResolvedOperation> collectOperations(const Document& doc)
{
    vector<ResolvedOperation> result;
    for (const auto& [path, pathItem] : doc.paths) {
        for (const auto& method : httpMethods) {
            auto it = pathItem.operations.find(method);
            if (it == pathItem.operations.end())
                continue;
            result.push_back(resolveOneOperation(doc, method, path, pathItem, it->second));
        }
        // OAS 3.2+: operations under a non-standard method (PathItem::additionalOperations),
        // keyed by that method's name exactly as written (not lowercased, unlike the fixed set
        // above).
        for (const auto& [method, op] : pathItem.additionalOperations)
            result.push_back(resolveOneOperation(doc, method, path, pathItem, op));
    }
    return result;
}

}
