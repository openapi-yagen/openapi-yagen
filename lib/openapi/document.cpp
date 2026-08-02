#include "document.h"

#include <algorithm>

#include "ref.h"

using namespace std;

namespace OpenApi {

const vector<Str> httpMethods = { "get", "put", "post", "delete", "options", "head", "patch", "trace" };

namespace {

map<Str, MediaType> parseContentMap(const NodeWalker& w)
{
    return w
        .optionalMap([](const NodeWalker& cw) {
            MediaType mt;
            mt.raw = cw.required<Node>();
            auto schemaWalker = cw["schema"];
            if (!schemaWalker.isEmpty())
                mt.schema = parseSchema(schemaWalker);
            return mt;
        })
        .value_or(map<Str, MediaType>());
}

}

ParameterPtr parseParameter(const NodeWalker& w)
{
    auto p = make_shared<Parameter>();
    p->raw = w.required<Node>();

    p->ref = w["$ref"].optional<Str>();
    if (p->ref)
        return p;

    p->name = w["name"].required<Str>();
    p->in = w["in"].required<Str>();
    p->description = w["description"].optional<Str>();
    // Path parameters are implicitly required even if the spec omits "required" (per the OpenAPI
    // spec, they always must be); every other "in" defaults to optional.
    p->required = w["required"].optional<bool>().value_or(p->in == "path");
    auto schemaWalker = w["schema"];
    if (!schemaWalker.isEmpty())
        p->schema = parseSchema(schemaWalker);

    return p;
}

RequestBodyPtr parseRequestBody(const NodeWalker& w)
{
    auto rb = make_shared<RequestBody>();
    rb->raw = w.required<Node>();

    rb->ref = w["$ref"].optional<Str>();
    if (rb->ref)
        return rb;

    rb->description = w["description"].optional<Str>();
    rb->required = w["required"].optional<bool>().value_or(false);
    rb->content = parseContentMap(w["content"]);

    return rb;
}

ResponsePtr parseResponse(const NodeWalker& w)
{
    auto r = make_shared<Response>();
    r->raw = w.required<Node>();

    r->ref = w["$ref"].optional<Str>();
    if (r->ref)
        return r;

    r->description = w["description"].optional<Str>();
    r->content = parseContentMap(w["content"]);

    return r;
}

Operation parseOperation(const NodeWalker& w)
{
    Operation op;
    op.operationId = w["operationId"].optional<Str>();
    op.summary = w["summary"].optional<Str>();
    op.description = w["description"].optional<Str>();
    op.tags = w["tags"].optionalList([](const NodeWalker& cw) { return cw.required<Str>(); }).value_or(vector<Str>());
    op.parameters = w["parameters"].optionalList(parseParameter).value_or(vector<ParameterPtr>());

    auto requestBodyWalker = w["requestBody"];
    if (!requestBodyWalker.isEmpty())
        op.requestBody = parseRequestBody(requestBodyWalker);

    op.responses = w["responses"].optionalMap(parseResponse).value_or(ResponseMap());

    return op;
}

PathItem parsePathItem(const NodeWalker& w)
{
    PathItem item;
    item.parameters = w["parameters"].optionalList(parseParameter).value_or(vector<ParameterPtr>());
    for (const auto& method : httpMethods) {
        auto opWalker = w[method];
        if (!opWalker.isEmpty())
            item.operations[method] = parseOperation(opWalker);
    }
    return item;
}

Document parseDocument(const NodeWalker& w)
{
    Document doc;
    auto componentsWalker = w["components"];
    doc.components.schemas = componentsWalker["schemas"].optionalMap(parseSchema).value_or(SchemaMap());
    doc.components.parameters = componentsWalker["parameters"].optionalMap(parseParameter).value_or(ParameterMap());
    doc.components.requestBodies
        = componentsWalker["requestBodies"].optionalMap(parseRequestBody).value_or(RequestBodyMap());
    doc.components.responses = componentsWalker["responses"].optionalMap(parseResponse).value_or(ResponseMap());
    doc.paths = w["paths"].optionalMap(parsePathItem).value_or(Paths());
    return doc;
}

namespace {
const Str parameterRefPrefix = "#/components/parameters/";
const Str requestBodyRefPrefix = "#/components/requestBodies/";
const Str responseRefPrefix = "#/components/responses/";
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

vector<ResolvedOperation> collectOperations(const Document& doc)
{
    vector<ResolvedOperation> result;
    for (const auto& [path, pathItem] : doc.paths) {
        for (const auto& method : httpMethods) {
            auto it = pathItem.operations.find(method);
            if (it == pathItem.operations.end())
                continue;
            const auto& op = it->second;

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

            result.push_back(std::move(resolved));
        }
    }
    return result;
}

}
