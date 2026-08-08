#include "resolve.h"

#include <set>

using namespace std;

namespace OpenApi {

namespace {

void resolveSchemaPtr(const SchemaMap& schemas, SchemaPtr& slot, set<const Schema*>& visited)
{
    if (!slot)
        return;
    if (slot->ref)
        slot = deref(schemas, slot);
    if (!slot)
        return;
    if (!visited.insert(slot.get()).second)
        return; // already walked (or currently being walked further up the call stack) - stop

    for (auto& [name, prop] : slot->properties)
        resolveSchemaPtr(schemas, prop, visited);
    resolveSchemaPtr(schemas, slot->items, visited);
    resolveSchemaPtr(schemas, slot->additionalPropertiesSchema, visited);
    for (auto& s : slot->allOf)
        resolveSchemaPtr(schemas, s, visited);
    for (auto& s : slot->oneOf)
        resolveSchemaPtr(schemas, s, visited);
    for (auto& s : slot->anyOf)
        resolveSchemaPtr(schemas, s, visited);
    resolveSchemaPtr(schemas, slot->notSchema, visited);
    for (auto& [name, def] : slot->defs) // $defs, OAS 3.1+
        resolveSchemaPtr(schemas, def, visited);
}

void resolveHeaderPtr(const Document& doc, HeaderPtr& slot, set<const Schema*>& visited);

void resolveContent(const Document& doc, map<Str, MediaType>& content, set<const Schema*>& visited)
{
    for (auto& [mediaType, media] : content) {
        resolveSchemaPtr(doc.components.schemas, media.schema, visited);
        resolveSchemaPtr(doc.components.schemas, media.itemSchema, visited);
        for (auto& [propName, encoding] : media.encoding)
            for (auto& [headerName, header] : encoding.headers)
                resolveHeaderPtr(doc, header, visited);
    }
}

void resolveHeaderPtr(const Document& doc, HeaderPtr& slot, set<const Schema*>& visited)
{
    if (!slot)
        return;
    if (slot->ref)
        slot = derefHeader(doc, slot);
    if (!slot)
        return;
    resolveSchemaPtr(doc.components.schemas, slot->schema, visited);
    resolveContent(doc, slot->content, visited);
}

void resolveParameterPtr(const Document& doc, ParameterPtr& slot, set<const Schema*>& visited)
{
    slot = derefParameter(doc, slot);
    if (!slot)
        return;
    resolveSchemaPtr(doc.components.schemas, slot->schema, visited);
    resolveContent(doc, slot->content, visited);
}

void resolveParameters(const Document& doc, vector<ParameterPtr>& params, set<const Schema*>& visited)
{
    for (auto& p : params)
        resolveParameterPtr(doc, p, visited);
}

void resolveResponsePtr(const Document& doc, ResponsePtr& slot, set<const Schema*>& visited)
{
    slot = derefResponse(doc, slot);
    if (!slot)
        return;
    for (auto& [name, header] : slot->headers)
        resolveHeaderPtr(doc, header, visited);
    resolveContent(doc, slot->content, visited);
    // Link objects don't carry a Schema (their `parameters`/`requestBody` are runtime
    // expressions, not schemas) - only their own $ref (if any) needs resolving, which
    // `derefChain`-based lookups elsewhere already handle when a generator calls for it; nothing
    // schema-shaped to walk here.
}

void resolveRequestBodyPtr(const Document& doc, RequestBodyPtr& slot, set<const Schema*>& visited)
{
    slot = derefRequestBody(doc, slot);
    if (!slot)
        return;
    resolveContent(doc, slot->content, visited);
}

void resolvePathItem(const Document& doc, PathItem& item, set<const Schema*>& visited);

void resolveOperation(const Document& doc, Operation& op, set<const Schema*>& visited)
{
    resolveParameters(doc, op.parameters, visited);
    if (op.requestBody)
        resolveRequestBodyPtr(doc, op.requestBody, visited);
    for (auto& [status, r] : op.responses)
        resolveResponsePtr(doc, r, visited);
    for (auto& [name, callback] : op.callbacks) {
        callback = derefCallback(doc, callback);
        if (!callback)
            continue;
        for (auto& [expr, pathItem] : callback->expressions)
            if (pathItem)
                resolvePathItem(doc, *pathItem, visited);
    }
}

void resolvePathItem(const Document& doc, PathItem& item, set<const Schema*>& visited)
{
    resolveParameters(doc, item.parameters, visited);
    for (auto& [method, op] : item.operations)
        resolveOperation(doc, op, visited);
    for (auto& [method, op] : item.additionalOperations) // OAS 3.2+
        resolveOperation(doc, op, visited);
}

}

void resolveAllRefs(Document& doc)
{
    set<const Schema*> visited;

    for (auto& [name, s] : doc.components.schemas)
        resolveSchemaPtr(doc.components.schemas, s, visited);

    for (auto& [name, p] : doc.components.parameters)
        resolveParameterPtr(doc, p, visited);
    for (auto& [name, rb] : doc.components.requestBodies)
        resolveRequestBodyPtr(doc, rb, visited);
    for (auto& [name, r] : doc.components.responses)
        resolveResponsePtr(doc, r, visited);
    for (auto& [name, h] : doc.components.headers)
        resolveHeaderPtr(doc, h, visited);
    for (auto& [name, cb] : doc.components.callbacks) {
        cb = derefCallback(doc, cb);
        if (!cb)
            continue;
        for (auto& [expr, pathItem] : cb->expressions)
            if (pathItem)
                resolvePathItem(doc, *pathItem, visited);
    }
    for (auto& [path, item] : doc.components.pathItems)
        resolvePathItem(doc, item, visited);

    for (auto& [path, item] : doc.paths)
        resolvePathItem(doc, item, visited);
    for (auto& [path, item] : doc.webhooks)
        resolvePathItem(doc, item, visited);
}

}
