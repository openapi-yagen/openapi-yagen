#pragma once

#include <map>

#include <quickjs/quickjs.h>

#include "../js/tools.h"
#include "../openapi/schema.h"

namespace Generator {

// Builds a cycle-safe JSValue graph from an already fully-resolved (OpenApi::resolveAllRefs)
// Schema, exposing it to generator JS code as a $ref-free mirror of the raw OpenAPI document (see
// lib/openapi/resolve.h): the resulting object is `nodeToJSValue(schema->raw)` (the exact
// original wire shape, including any vendor/unmodeled fields) with only the nested-schema-bearing
// keys (`properties`, `items`, `additionalProperties`, `allOf`/`oneOf`/`anyOf`) overwritten by the
// recursively-built, already-resolved value - so no `$ref` and no invented fields ever appear.
//
// One instance must be reused for a whole build (a whole Document, and anything derived from it)
// so that a repeated or self-referential schema becomes the SAME JS object (`===`), not an
// independent copy: buildSchemaValue memoizes by the source Schema's pointer identity, dup'ing the
// previously-built JSValue on reuse instead of rebuilding it.
class OpenApiJsGraphBuilder {
public:
    explicit OpenApiJsGraphBuilder(JSContext* ctx);

    JSValue buildSchemaValue(const OpenApi::SchemaPtr& schema);

private:
    JSContext* ctx;
    std::map<const void*, JS::JSValueWrapper> schemaMemo;
};

}
