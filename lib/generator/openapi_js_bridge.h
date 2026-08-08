#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include <quickjs/quickjs.h>

#include "../js/tools.h"
#include "../openapi/document.h"

namespace Generator {

// Builds a cycle-safe JSValue graph from an already fully-resolved (OpenApi::resolveAllRefs)
// Document, exposing it to generator JS code as a $ref-free mirror of the raw OpenAPI document
// (see lib/openapi/resolve.h): every Schema/Parameter/RequestBody/Response/Header object is built
// as `nodeToJSValue(x->raw)` (the exact original wire shape) with only the nested-schema-bearing
// keys (`schema`, `content.<mediaType>.schema`, `content.<mediaType>.encoding.*.headers.*`,
// `properties`, `items`, `additionalProperties`, `allOf`/`oneOf`/`anyOf`, `headers`, `callbacks`)
// overwritten by the recursively-built, already-resolved value - so no `$ref` and no invented
// fields ever appear anywhere in the result.
//
// One instance must be reused for a whole build (a whole Document, and anything derived from it,
// e.g. a collectOperations() result) so that a repeated or self-referential object becomes the
// SAME JS object (`===`), not an independent copy: every build*Value method for a
// Schema/Parameter/RequestBody/Response/Header memoizes by the source object's pointer identity,
// dup'ing the previously-built JSValue on reuse instead of rebuilding it. Link/Example/
// SecurityScheme objects don't get this treatment - they're leaves (never reached via a shared
// $ref from more than one meaningfully-different place in practice) and are built fresh each time.
class OpenApiJsGraphBuilder {
public:
    explicit OpenApiJsGraphBuilder(JSContext* ctx);

    JSValue buildSchemaValue(const OpenApi::SchemaPtr& schema);
    JSValue buildParameterValue(const OpenApi::ParameterPtr& parameter);
    JSValue buildRequestBodyValue(const OpenApi::RequestBodyPtr& requestBody);
    JSValue buildResponseValue(const OpenApi::ResponsePtr& response);
    JSValue buildHeaderValue(const OpenApi::HeaderPtr& header);
    JSValue buildCallbackValue(const OpenApi::CallbackPtr& callback);
    JSValue buildLinkValue(const OpenApi::Link& link);
    JSValue buildExampleValue(const OpenApi::Example& example);
    JSValue buildSecuritySchemeValue(const OpenApi::SecurityScheme& scheme);

    // Builds the whole document: `schemaNode` verbatim (info/servers/tags/... untouched), with
    // every named component under `components.*`/`paths.*`/`webhooks.*` replaced by its resolved,
    // deref'd, cycle-safe value.
    JSValue buildDocumentValue(const Node& schemaNode, const OpenApi::Document& doc);

    // Returns the name a Schema/Parameter/RequestBody/Response/Header is registered under in
    // `components.*` (populated by buildDocumentValue), or nullopt if `x` is an inline/anonymous
    // definition, never reached via $ref. Identity-based (heap pointer of the JS object itself),
    // not name-string-based - works uniformly across all component kinds.
    std::optional<std::string> nameOf(JSValueConst x) const;

private:
    JSValue getOrCreateChildObject(JSValue obj, const std::string& key);
    void overwriteParameterArray(JSValue parentObj, const std::string& key,
                                 const std::vector<OpenApi::ParameterPtr>& params);
    void overwriteContentSchemas(JSValue contentObj, const std::map<OpenApi::Str, OpenApi::MediaType>& content);
    // Patches `pathItemObj` (an existing, raw-based JS object for a Path Item Object) in place:
    // resolves its `parameters` array and each operation's `parameters`/`requestBody`/
    // `responses`/`callbacks`.
    void overlayPathItem(JSValue pathItemObj, const OpenApi::PathItem& item);

    JSContext* ctx;
    std::map<const void*, JS::JSValueWrapper> schemaMemo;
    std::map<const void*, JS::JSValueWrapper> parameterMemo;
    std::map<const void*, JS::JSValueWrapper> requestBodyMemo;
    std::map<const void*, JS::JSValueWrapper> responseMemo;
    std::map<const void*, JS::JSValueWrapper> headerMemo;
    std::map<const void*, JS::JSValueWrapper> callbackMemo;
    std::map<const void*, std::string> componentNames; // JS heap pointer -> components.* name
};

// Builds a plain array from OpenApi::collectOperations()'s result: each operation is a computed,
// merged view (not parsed from a single spec node), so - unlike build*Value above - it's built as
// an explicit set of named fields rather than "raw + override". Uses `builder` for the embedded
// parameter/requestBody/response objects, so identity is shared with anything else built through
// the same builder (e.g. `operations[i].parameters[j].schema === schema.components.schemas.X`
// holds whenever they really are the same schema).
JSValue buildOperationsArray(JSContext* ctx, OpenApiJsGraphBuilder& builder,
                             const std::vector<OpenApi::ResolvedOperation>& operations);

}
