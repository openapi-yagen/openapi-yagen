#include "openapi_js_bridge.h"

#include <stdexcept>
#include <vector>

using namespace std;
using namespace OpenApi;
using namespace JS;

namespace Generator {

namespace {

JSValue buildSchemaArray(JSContext* ctx, const vector<JSValue>& items)
{
    auto arr = JS_NewArray(ctx);
    checkForException(ctx, arr, "<b7b7f6a9> Cannot create array");
    for (size_t i = 0; i < items.size(); i++)
        JS_DefinePropertyValueUint32(ctx, arr, (uint32_t)i, items[i], JS_PROP_C_W_E);
    return arr;
}

}

OpenApiJsGraphBuilder::OpenApiJsGraphBuilder(JSContext* ctx)
    : ctx(ctx)
{
}

JSValue OpenApiJsGraphBuilder::buildSchemaValue(const SchemaPtr& schema)
{
    if (!schema)
        return JS_NULL;
    if (schema->ref)
        throw runtime_error(
            "<a7a7f6a8> Unresolved $ref reached the JS graph builder - OpenApi::resolveAllRefs must run first");

    const void* key = schema.get();
    if (auto it = schemaMemo.find(key); it != schemaMemo.end())
        return JS_DupValue(ctx, *it->second);

    auto obj = nodeToJSValue(ctx, schema->raw);
    schemaMemo.emplace(key, JSValueWrapper(ctx, JS_DupValue(ctx, obj))); // memoize BEFORE recursing into children

    if (!schema->properties.empty()) {
        auto propsObj = JS_NewObject(ctx);
        checkForException(ctx, propsObj, "<c8c8f6aa> Cannot create object");
        for (const auto& [name, prop] : schema->properties)
            setObjProperty(ctx, propsObj, name, buildSchemaValue(prop));
        setObjProperty(ctx, obj, "properties", propsObj);
    }
    if (schema->items)
        setObjProperty(ctx, obj, "items", buildSchemaValue(schema->items));
    if (schema->additionalPropertiesSchema)
        setObjProperty(ctx, obj, "additionalProperties", buildSchemaValue(schema->additionalPropertiesSchema));
    if (!schema->allOf.empty()) {
        vector<JSValue> items;
        for (const auto& s : schema->allOf)
            items.push_back(buildSchemaValue(s));
        setObjProperty(ctx, obj, "allOf", buildSchemaArray(ctx, items));
    }
    if (!schema->oneOf.empty()) {
        vector<JSValue> items;
        for (const auto& s : schema->oneOf)
            items.push_back(buildSchemaValue(s));
        setObjProperty(ctx, obj, "oneOf", buildSchemaArray(ctx, items));
    }
    if (!schema->anyOf.empty()) {
        vector<JSValue> items;
        for (const auto& s : schema->anyOf)
            items.push_back(buildSchemaValue(s));
        setObjProperty(ctx, obj, "anyOf", buildSchemaArray(ctx, items));
    }

    return obj;
}

JSValue OpenApiJsGraphBuilder::buildParameterValue(const ParameterPtr& parameter)
{
    if (!parameter)
        return JS_NULL;
    if (parameter->ref)
        throw runtime_error("<f0f1a2b3> Unresolved $ref reached the JS graph builder (parameter) - "
                            "OpenApi::resolveAllRefs must run first");

    const void* key = parameter.get();
    if (auto it = parameterMemo.find(key); it != parameterMemo.end())
        return JS_DupValue(ctx, *it->second);

    auto obj = nodeToJSValue(ctx, parameter->raw);
    parameterMemo.emplace(key, JSValueWrapper(ctx, JS_DupValue(ctx, obj)));

    if (parameter->schema)
        setObjProperty(ctx, obj, "schema", buildSchemaValue(parameter->schema));

    return obj;
}

void OpenApiJsGraphBuilder::overwriteContentSchemas(JSValue contentObj, const map<Str, MediaType>& content)
{
    for (const auto& [mediaType, media] : content) {
        if (!media.schema)
            continue;
        auto entryObj = JS_GetPropertyStr(ctx, contentObj, mediaType.c_str());
        setObjProperty(ctx, entryObj, "schema", buildSchemaValue(media.schema));
        JS_FreeValue(ctx, entryObj);
    }
}

JSValue OpenApiJsGraphBuilder::buildRequestBodyValue(const RequestBodyPtr& requestBody)
{
    if (!requestBody)
        return JS_NULL;
    if (requestBody->ref)
        throw runtime_error("<c4d5e6f7> Unresolved $ref reached the JS graph builder (requestBody) - "
                            "OpenApi::resolveAllRefs must run first");

    const void* key = requestBody.get();
    if (auto it = requestBodyMemo.find(key); it != requestBodyMemo.end())
        return JS_DupValue(ctx, *it->second);

    auto obj = nodeToJSValue(ctx, requestBody->raw);
    requestBodyMemo.emplace(key, JSValueWrapper(ctx, JS_DupValue(ctx, obj)));

    if (!requestBody->content.empty()) {
        auto contentObj = JS_GetPropertyStr(ctx, obj, "content");
        overwriteContentSchemas(contentObj, requestBody->content);
        JS_FreeValue(ctx, contentObj);
    }

    return obj;
}

JSValue OpenApiJsGraphBuilder::buildResponseValue(const ResponsePtr& response)
{
    if (!response)
        return JS_NULL;
    if (response->ref)
        throw runtime_error("<a8b9c0d1> Unresolved $ref reached the JS graph builder (response) - "
                            "OpenApi::resolveAllRefs must run first");

    const void* key = response.get();
    if (auto it = responseMemo.find(key); it != responseMemo.end())
        return JS_DupValue(ctx, *it->second);

    auto obj = nodeToJSValue(ctx, response->raw);
    responseMemo.emplace(key, JSValueWrapper(ctx, JS_DupValue(ctx, obj)));

    if (!response->content.empty()) {
        auto contentObj = JS_GetPropertyStr(ctx, obj, "content");
        overwriteContentSchemas(contentObj, response->content);
        JS_FreeValue(ctx, contentObj);
    }

    return obj;
}

JSValue OpenApiJsGraphBuilder::getOrCreateChildObject(JSValue obj, const string& key)
{
    auto existing = JS_GetPropertyStr(ctx, obj, key.c_str());
    if (JS_IsObject(existing))
        return existing;
    JS_FreeValue(ctx, existing);
    auto created = JS_NewObject(ctx);
    checkForException(ctx, created, "<e2e3f4a5> Cannot create object");
    setObjProperty(ctx, obj, key, JS_DupValue(ctx, created));
    return created;
}

void OpenApiJsGraphBuilder::overwriteParameterArray(JSValue parentObj, const string& key,
                                                    const vector<ParameterPtr>& params)
{
    auto arr = JS_GetPropertyStr(ctx, parentObj, key.c_str());
    for (size_t i = 0; i < params.size(); i++)
        JS_SetPropertyUint32(ctx, arr, (uint32_t)i, buildParameterValue(params[i]));
    JS_FreeValue(ctx, arr);
}

JSValue OpenApiJsGraphBuilder::buildDocumentValue(const Node& schemaNode, const Document& doc)
{
    auto obj = nodeToJSValue(ctx, schemaNode);

    auto componentsObj = getOrCreateChildObject(obj, "components") | wrap(ctx);

    auto schemasObj = getOrCreateChildObject(*componentsObj, "schemas") | wrap(ctx);
    for (const auto& [name, s] : doc.components.schemas) {
        auto value = buildSchemaValue(s);
        componentNames.emplace(JS_VALUE_GET_PTR(value), name);
        setObjProperty(ctx, *schemasObj, name, value);
    }

    auto parametersObj = getOrCreateChildObject(*componentsObj, "parameters") | wrap(ctx);
    for (const auto& [name, p] : doc.components.parameters) {
        auto value = buildParameterValue(p);
        componentNames.emplace(JS_VALUE_GET_PTR(value), name);
        setObjProperty(ctx, *parametersObj, name, value);
    }

    auto requestBodiesObj = getOrCreateChildObject(*componentsObj, "requestBodies") | wrap(ctx);
    for (const auto& [name, rb] : doc.components.requestBodies) {
        auto value = buildRequestBodyValue(rb);
        componentNames.emplace(JS_VALUE_GET_PTR(value), name);
        setObjProperty(ctx, *requestBodiesObj, name, value);
    }

    auto responsesCompObj = getOrCreateChildObject(*componentsObj, "responses") | wrap(ctx);
    for (const auto& [name, r] : doc.components.responses) {
        auto value = buildResponseValue(r);
        componentNames.emplace(JS_VALUE_GET_PTR(value), name);
        setObjProperty(ctx, *responsesCompObj, name, value);
    }

    auto pathsObj = getOrCreateChildObject(obj, "paths") | wrap(ctx);
    for (const auto& [path, item] : doc.paths) {
        auto pathItemObj = getOrCreateChildObject(*pathsObj, path) | wrap(ctx);

        if (!item.parameters.empty())
            overwriteParameterArray(*pathItemObj, "parameters", item.parameters);

        for (const auto& [method, op] : item.operations) {
            auto opObj = getOrCreateChildObject(*pathItemObj, method) | wrap(ctx);

            if (!op.parameters.empty())
                overwriteParameterArray(*opObj, "parameters", op.parameters);
            if (op.requestBody)
                setObjProperty(ctx, *opObj, "requestBody", buildRequestBodyValue(op.requestBody));
            if (!op.responses.empty()) {
                auto opResponsesObj = getOrCreateChildObject(*opObj, "responses") | wrap(ctx);
                for (const auto& [status, r] : op.responses)
                    setObjProperty(ctx, *opResponsesObj, status, buildResponseValue(r));
            }
        }
    }

    return obj;
}

optional<string> OpenApiJsGraphBuilder::nameOf(JSValueConst x) const
{
    auto it = componentNames.find(JS_VALUE_GET_PTR(x));
    if (it == componentNames.end())
        return nullopt;
    return it->second;
}

}
