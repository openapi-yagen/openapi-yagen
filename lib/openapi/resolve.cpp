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
}

void resolveContent(const SchemaMap& schemas, map<Str, MediaType>& content, set<const Schema*>& visited)
{
    for (auto& [mediaType, media] : content)
        resolveSchemaPtr(schemas, media.schema, visited);
}

void resolveParameters(const Document& doc, vector<ParameterPtr>& params, set<const Schema*>& visited)
{
    for (auto& p : params) {
        p = derefParameter(doc, p);
        if (p)
            resolveSchemaPtr(doc.components.schemas, p->schema, visited);
    }
}

}

void resolveAllRefs(Document& doc)
{
    set<const Schema*> visited;

    for (auto& [name, s] : doc.components.schemas)
        resolveSchemaPtr(doc.components.schemas, s, visited);

    for (auto& [name, p] : doc.components.parameters) {
        p = derefParameter(doc, p);
        if (p)
            resolveSchemaPtr(doc.components.schemas, p->schema, visited);
    }
    for (auto& [name, rb] : doc.components.requestBodies) {
        rb = derefRequestBody(doc, rb);
        if (rb)
            resolveContent(doc.components.schemas, rb->content, visited);
    }
    for (auto& [name, r] : doc.components.responses) {
        r = derefResponse(doc, r);
        if (r)
            resolveContent(doc.components.schemas, r->content, visited);
    }

    for (auto& [path, item] : doc.paths) {
        resolveParameters(doc, item.parameters, visited);
        for (auto& [method, op] : item.operations) {
            resolveParameters(doc, op.parameters, visited);
            if (op.requestBody) {
                op.requestBody = derefRequestBody(doc, op.requestBody);
                resolveContent(doc.components.schemas, op.requestBody->content, visited);
            }
            for (auto& [status, r] : op.responses) {
                r = derefResponse(doc, r);
                if (r)
                    resolveContent(doc.components.schemas, r->content, visited);
            }
        }
    }
}

}
