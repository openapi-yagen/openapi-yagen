#include "filter.h"

#include <map>
#include <set>
#include <vector>

using namespace std;

namespace OpenApi {

namespace {

bool matchesAnyTag(const vector<Str>& opTags, const set<Str>& wanted)
{
    for (const auto& t : opTags)
        if (wanted.count(t))
            return true;
    return false;
}

// The set of components still reachable from a surviving operation, tracked by raw pointer
// identity - valid because resolveAllRefs() has already replaced every $ref-only pointer with the
// very shared_ptr that lives in the corresponding doc.components.* map (see resolve.cpp).
struct ReachableSet {
    set<const Schema*> schemas;
    set<const Parameter*> parameters;
    set<const RequestBody*> requestBodies;
    set<const Response*> responses;
    set<const Header*> headers;
};

void collectSchema(const SchemaPtr& s, ReachableSet& r)
{
    if (!s || !r.schemas.insert(s.get()).second)
        return; // null, or already walked (cycle-safe, same idea as resolve.cpp's visited set)

    for (const auto& [name, prop] : s->properties)
        collectSchema(prop, r);
    collectSchema(s->items, r);
    collectSchema(s->additionalPropertiesSchema, r);
    for (const auto& b : s->allOf)
        collectSchema(b, r);
    for (const auto& b : s->oneOf)
        collectSchema(b, r);
    for (const auto& b : s->anyOf)
        collectSchema(b, r);
    collectSchema(s->notSchema, r);
    for (const auto& [name, def] : s->defs) // $defs, OAS 3.1+
        collectSchema(def, r);
}

void collectContent(const map<Str, MediaType>& content, ReachableSet& r);

void collectHeader(const HeaderPtr& h, ReachableSet& r)
{
    if (!h || !r.headers.insert(h.get()).second)
        return;
    collectSchema(h->schema, r);
    collectContent(h->content, r);
}

void collectContent(const map<Str, MediaType>& content, ReachableSet& r)
{
    for (const auto& [mediaType, media] : content) {
        collectSchema(media.schema, r);
        collectSchema(media.itemSchema, r);
        for (const auto& [propName, encoding] : media.encoding)
            for (const auto& [headerName, header] : encoding.headers)
                collectHeader(header, r);
    }
}

void collectParameter(const ParameterPtr& p, ReachableSet& r)
{
    if (!p || !r.parameters.insert(p.get()).second)
        return;
    collectSchema(p->schema, r);
    collectContent(p->content, r);
}

void collectRequestBody(const RequestBodyPtr& rb, ReachableSet& r)
{
    if (!rb || !r.requestBodies.insert(rb.get()).second)
        return;
    collectContent(rb->content, r);
}

void collectResponse(const ResponsePtr& resp, ReachableSet& r)
{
    if (!resp || !r.responses.insert(resp.get()).second)
        return;
    for (const auto& [name, h] : resp->headers)
        collectHeader(h, r);
    collectContent(resp->content, r);
}

void collectOperation(const Operation& op, ReachableSet& r)
{
    for (const auto& p : op.parameters)
        collectParameter(p, r);
    if (op.requestBody)
        collectRequestBody(op.requestBody, r);
    for (const auto& [status, resp] : op.responses)
        collectResponse(resp, r);
}

void computeReachable(const Paths& paths, ReachableSet& r)
{
    for (const auto& [path, item] : paths) {
        for (const auto& p : item.parameters)
            collectParameter(p, r);
        for (const auto& [method, op] : item.operations)
            collectOperation(op, r);
        for (const auto& [method, op] : item.additionalOperations) // OAS 3.2+
            collectOperation(op, r);
    }
}

void filterOperationsByTag(map<Str, Operation>& operations, const set<Str>& wanted)
{
    erase_if(operations, [&](const auto& kv) { return !matchesAnyTag(kv.second.tags, wanted); });
}

void filterPathsByTag(Paths& paths, const set<Str>& wanted)
{
    for (auto& [path, item] : paths) {
        filterOperationsByTag(item.operations, wanted);
        filterOperationsByTag(item.additionalOperations, wanted);
    }
    erase_if(paths,
             [](const auto& kv) { return kv.second.operations.empty() && kv.second.additionalOperations.empty(); });
}

// PathItem Object fields that aren't a per-method operation - always kept as-is when pruning a raw
// path item's method keys below (everything else still present is either a standard httpMethods
// name or an OAS 3.2+ custom method name, both operation-shaped).
const set<Str> nonOperationPathItemFields = { "$ref", "summary", "description", "servers", "parameters" };

// Prunes a single raw path item's raw method keys (get/post/..., and any OAS 3.2+ custom method
// name) down to whatever survived filtering in the already-filtered `item`, leaving every other
// field (summary, parameters, ...) untouched.
void pruneRawPathItem(Node& rawPathItem, const PathItem& item)
{
    auto* m = get_if<Node::Map>(&rawPathItem.value);
    if (!m)
        return;
    set<Str> keepMethods;
    for (const auto& [method, op] : item.operations)
        keepMethods.insert(method);
    for (const auto& [method, op] : item.additionalOperations)
        keepMethods.insert(method);
    erase_if(*m, [&](const auto& kv) {
        if (nonOperationPathItemFields.count(kv.first))
            return false;
        return !keepMethods.count(kv.first);
    });
}

// Prunes a raw `paths`/`webhooks` map node down to the path keys still present in the already-
// filtered `paths`, then prunes each surviving path item's own method keys the same way.
void pruneRawPaths(Node& rawPathsNode, const Paths& paths)
{
    auto* m = get_if<Node::Map>(&rawPathsNode.value);
    if (!m)
        return;
    set<Str> keepPaths;
    for (const auto& [path, item] : paths)
        keepPaths.insert(path);
    erase_if(*m, [&](const auto& kv) { return !keepPaths.count(kv.first); });

    for (const auto& [path, item] : paths) {
        auto it = m->find(path);
        if (it != m->end())
            pruneRawPathItem(it->second, item);
    }
}

// Prunes one named raw `components.<key>` map (e.g. "schemas") down to `keepNames`. A no-op if
// `components` or `components.<key>` isn't present in the raw tree.
void pruneRawComponentsSection(Node& componentsNode, const Str& key, const set<Str>& keepNames)
{
    auto* componentsMap = get_if<Node::Map>(&componentsNode.value);
    if (!componentsMap)
        return;
    auto it = componentsMap->find(key);
    if (it == componentsMap->end())
        return;
    auto* sectionMap = get_if<Node::Map>(&it->second.value);
    if (!sectionMap)
        return;
    erase_if(*sectionMap, [&](const auto& kv) { return !keepNames.count(kv.first); });
}

set<Str> mapKeys(const auto& m)
{
    set<Str> keys;
    for (const auto& [name, value] : m)
        keys.insert(name);
    return keys;
}

// Mirrors filterByTags' decisions (already applied to `doc`) onto the raw spec tree it was parsed
// from - see filter.h's comment on why this is necessary.
void pruneRawSchemaNode(Node& schemaNode, const Document& doc, const set<Str>& wanted)
{
    auto* docMap = get_if<Node::Map>(&schemaNode.value);
    if (!docMap)
        return;

    if (auto it = docMap->find("paths"); it != docMap->end())
        pruneRawPaths(it->second, doc.paths);
    if (auto it = docMap->find("webhooks"); it != docMap->end())
        pruneRawPaths(it->second, doc.webhooks);

    if (auto it = docMap->find("components"); it != docMap->end()) {
        pruneRawComponentsSection(it->second, "schemas", mapKeys(doc.components.schemas));
        pruneRawComponentsSection(it->second, "parameters", mapKeys(doc.components.parameters));
        pruneRawComponentsSection(it->second, "requestBodies", mapKeys(doc.components.requestBodies));
        pruneRawComponentsSection(it->second, "responses", mapKeys(doc.components.responses));
        pruneRawComponentsSection(it->second, "headers", mapKeys(doc.components.headers));
    }

    if (auto it = docMap->find("tags"); it != docMap->end()) {
        auto* vec = get_if<Node::Vec>(&it->second.value);
        if (vec) {
            erase_if(*vec, [&](const Node& tagNode) {
                auto* tagMap = get_if<Node::Map>(&tagNode.value);
                if (!tagMap)
                    return true;
                auto nameIt = tagMap->find("name");
                if (nameIt == tagMap->end())
                    return true;
                auto* nameStr = get_if<Node::String>(&nameIt->second.value);
                return !nameStr || !wanted.count(*nameStr);
            });
        }
    }
}

}

void filterByTags(Document& doc, Node& schemaNode, const vector<Str>& tags)
{
    if (tags.empty())
        return;
    set<Str> wanted(tags.begin(), tags.end());

    filterPathsByTag(doc.paths, wanted);
    filterPathsByTag(doc.webhooks, wanted);

    ReachableSet reachable;
    computeReachable(doc.paths, reachable);
    computeReachable(doc.webhooks, reachable);

    erase_if(doc.components.schemas,
             [&](const auto& kv) { return !reachable.schemas.count(kv.second.get()); });
    erase_if(doc.components.parameters,
             [&](const auto& kv) { return !reachable.parameters.count(kv.second.get()); });
    erase_if(doc.components.requestBodies,
             [&](const auto& kv) { return !reachable.requestBodies.count(kv.second.get()); });
    erase_if(doc.components.responses,
             [&](const auto& kv) { return !reachable.responses.count(kv.second.get()); });
    erase_if(doc.components.headers,
             [&](const auto& kv) { return !reachable.headers.count(kv.second.get()); });

    erase_if(doc.tags, [&](const Tag& t) { return !wanted.count(t.name); });

    pruneRawSchemaNode(schemaNode, doc, wanted);
}

}
