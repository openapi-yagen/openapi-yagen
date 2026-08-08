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
    if (!schema->defs.empty()) { // $defs, OAS 3.1+
        auto defsObj = JS_NewObject(ctx);
        checkForException(ctx, defsObj, "<d9d9f6ab> Cannot create object");
        for (const auto& [name, def] : schema->defs)
            setObjProperty(ctx, defsObj, name, buildSchemaValue(def));
        setObjProperty(ctx, obj, "$defs", defsObj);
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
    if (!parameter->content.empty()) {
        auto contentObj = JS_GetPropertyStr(ctx, obj, "content");
        overwriteContentSchemas(contentObj, parameter->content);
        JS_FreeValue(ctx, contentObj);
    }

    return obj;
}

JSValue OpenApiJsGraphBuilder::buildHeaderValue(const HeaderPtr& header)
{
    if (!header)
        return JS_NULL;
    if (header->ref)
        throw runtime_error(
            "<b1c2d3e4> Unresolved $ref reached the JS graph builder (header) - OpenApi::resolveAllRefs must run first");

    const void* key = header.get();
    if (auto it = headerMemo.find(key); it != headerMemo.end())
        return JS_DupValue(ctx, *it->second);

    auto obj = nodeToJSValue(ctx, header->raw);
    headerMemo.emplace(key, JSValueWrapper(ctx, JS_DupValue(ctx, obj)));

    if (header->schema)
        setObjProperty(ctx, obj, "schema", buildSchemaValue(header->schema));
    if (!header->content.empty()) {
        auto contentObj = JS_GetPropertyStr(ctx, obj, "content");
        overwriteContentSchemas(contentObj, header->content);
        JS_FreeValue(ctx, contentObj);
    }

    return obj;
}

JSValue OpenApiJsGraphBuilder::buildLinkValue(const Link& link) { return nodeToJSValue(ctx, link.raw); }

JSValue OpenApiJsGraphBuilder::buildExampleValue(const Example& example) { return nodeToJSValue(ctx, example.raw); }

JSValue OpenApiJsGraphBuilder::buildSecuritySchemeValue(const SecurityScheme& scheme)
{
    return nodeToJSValue(ctx, scheme.raw);
}

void OpenApiJsGraphBuilder::overwriteContentSchemas(JSValue contentObj, const map<Str, MediaType>& content)
{
    for (const auto& [mediaType, media] : content) {
        auto entryObj = JS_GetPropertyStr(ctx, contentObj, mediaType.c_str());
        if (media.schema)
            setObjProperty(ctx, entryObj, "schema", buildSchemaValue(media.schema));
        if (media.itemSchema) // OAS 3.2+
            setObjProperty(ctx, entryObj, "itemSchema", buildSchemaValue(media.itemSchema));
        if (!media.encoding.empty()) {
            auto encodingObj = JS_GetPropertyStr(ctx, entryObj, "encoding");
            for (const auto& [propName, encoding] : media.encoding) {
                if (encoding.headers.empty())
                    continue;
                auto encEntryObj = JS_GetPropertyStr(ctx, encodingObj, propName.c_str());
                auto headersObj = JS_GetPropertyStr(ctx, encEntryObj, "headers");
                for (const auto& [headerName, header] : encoding.headers)
                    setObjProperty(ctx, headersObj, headerName, buildHeaderValue(header));
                JS_FreeValue(ctx, headersObj);
                JS_FreeValue(ctx, encEntryObj);
            }
            JS_FreeValue(ctx, encodingObj);
        }
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

    if (!response->headers.empty()) {
        auto headersObj = JS_GetPropertyStr(ctx, obj, "headers");
        for (const auto& [name, h] : response->headers)
            setObjProperty(ctx, headersObj, name, buildHeaderValue(h));
        JS_FreeValue(ctx, headersObj);
    }
    if (!response->content.empty()) {
        auto contentObj = JS_GetPropertyStr(ctx, obj, "content");
        overwriteContentSchemas(contentObj, response->content);
        JS_FreeValue(ctx, contentObj);
    }
    if (!response->links.empty()) {
        auto linksObj = JS_GetPropertyStr(ctx, obj, "links");
        for (const auto& [name, l] : response->links)
            setObjProperty(ctx, linksObj, name, buildLinkValue(*l));
        JS_FreeValue(ctx, linksObj);
    }

    return obj;
}

JSValue OpenApiJsGraphBuilder::buildCallbackValue(const CallbackPtr& callback)
{
    if (!callback)
        return JS_NULL;
    if (callback->ref)
        throw runtime_error("<c2d3e4f5> Unresolved $ref reached the JS graph builder (callback) - "
                            "OpenApi::resolveAllRefs must run first");

    const void* key = callback.get();
    if (auto it = callbackMemo.find(key); it != callbackMemo.end())
        return JS_DupValue(ctx, *it->second);

    auto obj = nodeToJSValue(ctx, callback->raw);
    callbackMemo.emplace(key, JSValueWrapper(ctx, JS_DupValue(ctx, obj)));

    for (const auto& [expr, item] : callback->expressions) {
        if (!item)
            continue;
        auto pathItemObj = getOrCreateChildObject(obj, expr) | wrap(ctx);
        overlayPathItem(*pathItemObj, *item);
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

void OpenApiJsGraphBuilder::overlayOperation(JSValue opObj, const Operation& op)
{
    if (!op.parameters.empty())
        overwriteParameterArray(opObj, "parameters", op.parameters);
    if (op.requestBody)
        setObjProperty(ctx, opObj, "requestBody", buildRequestBodyValue(op.requestBody));
    if (!op.responses.empty()) {
        auto opResponsesObj = getOrCreateChildObject(opObj, "responses") | wrap(ctx);
        for (const auto& [status, r] : op.responses)
            setObjProperty(ctx, *opResponsesObj, status, buildResponseValue(r));
    }
    if (!op.callbacks.empty()) {
        auto opCallbacksObj = getOrCreateChildObject(opObj, "callbacks") | wrap(ctx);
        for (const auto& [name, cb] : op.callbacks)
            setObjProperty(ctx, *opCallbacksObj, name, buildCallbackValue(cb));
    }
}

void OpenApiJsGraphBuilder::overlayPathItem(JSValue pathItemObj, const PathItem& item)
{
    if (!item.parameters.empty())
        overwriteParameterArray(pathItemObj, "parameters", item.parameters);

    for (const auto& [method, op] : item.operations) {
        auto opObj = getOrCreateChildObject(pathItemObj, method) | wrap(ctx);
        overlayOperation(*opObj, op);
    }
    if (!item.additionalOperations.empty()) { // OAS 3.2+
        auto additionalObj = getOrCreateChildObject(pathItemObj, "additionalOperations") | wrap(ctx);
        for (const auto& [method, op] : item.additionalOperations) {
            auto opObj = getOrCreateChildObject(*additionalObj, method) | wrap(ctx);
            overlayOperation(*opObj, op);
        }
    }
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

    if (!doc.components.headers.empty()) {
        auto headersCompObj = getOrCreateChildObject(*componentsObj, "headers") | wrap(ctx);
        for (const auto& [name, h] : doc.components.headers) {
            auto value = buildHeaderValue(h);
            componentNames.emplace(JS_VALUE_GET_PTR(value), name);
            setObjProperty(ctx, *headersCompObj, name, value);
        }
    }

    if (!doc.components.securitySchemes.empty()) {
        auto securitySchemesObj = getOrCreateChildObject(*componentsObj, "securitySchemes") | wrap(ctx);
        for (const auto& [name, s] : doc.components.securitySchemes)
            setObjProperty(ctx, *securitySchemesObj, name, buildSecuritySchemeValue(*s));
    }

    if (!doc.components.links.empty()) {
        auto linksObj = getOrCreateChildObject(*componentsObj, "links") | wrap(ctx);
        for (const auto& [name, l] : doc.components.links)
            setObjProperty(ctx, *linksObj, name, buildLinkValue(*l));
    }

    if (!doc.components.examples.empty()) {
        auto examplesObj = getOrCreateChildObject(*componentsObj, "examples") | wrap(ctx);
        for (const auto& [name, e] : doc.components.examples)
            setObjProperty(ctx, *examplesObj, name, buildExampleValue(*e));
    }

    if (!doc.components.callbacks.empty()) {
        auto callbacksObj = getOrCreateChildObject(*componentsObj, "callbacks") | wrap(ctx);
        for (const auto& [name, cb] : doc.components.callbacks) {
            auto value = buildCallbackValue(cb);
            componentNames.emplace(JS_VALUE_GET_PTR(value), name);
            setObjProperty(ctx, *callbacksObj, name, value);
        }
    }

    if (!doc.components.pathItems.empty()) {
        auto pathItemsObj = getOrCreateChildObject(*componentsObj, "pathItems") | wrap(ctx);
        for (const auto& [path, item] : doc.components.pathItems) {
            auto pathItemObj = getOrCreateChildObject(*pathItemsObj, path) | wrap(ctx);
            overlayPathItem(*pathItemObj, item);
        }
    }

    auto pathsObj = getOrCreateChildObject(obj, "paths") | wrap(ctx);
    for (const auto& [path, item] : doc.paths) {
        auto pathItemObj = getOrCreateChildObject(*pathsObj, path) | wrap(ctx);
        overlayPathItem(*pathItemObj, item);
    }

    if (!doc.webhooks.empty()) {
        auto webhooksObj = getOrCreateChildObject(obj, "webhooks") | wrap(ctx);
        for (const auto& [path, item] : doc.webhooks) {
            auto pathItemObj = getOrCreateChildObject(*webhooksObj, path) | wrap(ctx);
            overlayPathItem(*pathItemObj, item);
        }
    }

    return obj;
}

JSValue buildOperationsArray(JSContext* ctx, OpenApiJsGraphBuilder& builder,
                             const vector<ResolvedOperation>& operations)
{
    auto arr = JS_NewArray(ctx);
    checkForException(ctx, arr, "<f3f4a5b6> Cannot create array");

    for (size_t i = 0; i < operations.size(); i++) {
        const auto& op = operations[i];
        auto obj = JS_NewObject(ctx);
        checkForException(ctx, obj, "<a5b6c7d8> Cannot create object");

        setObjProperty(ctx, obj, "method", JS_NewString(ctx, op.method.c_str()));
        setObjProperty(ctx, obj, "path", JS_NewString(ctx, op.path.c_str()));
        setObjProperty(ctx, obj, "operationId", op.operationId ? JS_NewString(ctx, op.operationId->c_str()) : JS_NULL);
        setObjProperty(ctx, obj, "summary", op.summary ? JS_NewString(ctx, op.summary->c_str()) : JS_NULL);
        setObjProperty(ctx, obj, "description", op.description ? JS_NewString(ctx, op.description->c_str()) : JS_NULL);

        auto tagsArr = JS_NewArray(ctx);
        checkForException(ctx, tagsArr, "<b6c7d8e9> Cannot create array");
        for (size_t j = 0; j < op.tags.size(); j++)
            JS_DefinePropertyValueUint32(ctx, tagsArr, (uint32_t)j, JS_NewString(ctx, op.tags[j].c_str()),
                                         JS_PROP_C_W_E);
        setObjProperty(ctx, obj, "tags", tagsArr);

        auto paramsArr = JS_NewArray(ctx);
        checkForException(ctx, paramsArr, "<c7d8e9fa> Cannot create array");
        for (size_t j = 0; j < op.parameters.size(); j++)
            JS_DefinePropertyValueUint32(ctx, paramsArr, (uint32_t)j, builder.buildParameterValue(op.parameters[j]),
                                         JS_PROP_C_W_E);
        setObjProperty(ctx, obj, "parameters", paramsArr);

        setObjProperty(ctx, obj, "requestBody",
                       op.requestBody ? builder.buildRequestBodyValue(op.requestBody) : JS_NULL);

        auto responsesObj = JS_NewObject(ctx);
        checkForException(ctx, responsesObj, "<d8e9faab> Cannot create object");
        for (const auto& [status, r] : op.responses)
            setObjProperty(ctx, responsesObj, status, builder.buildResponseValue(r));
        setObjProperty(ctx, obj, "responses", responsesObj);

        JS_DefinePropertyValueUint32(ctx, arr, (uint32_t)i, obj, JS_PROP_C_W_E);
    }

    return arr;
}

optional<string> OpenApiJsGraphBuilder::nameOf(JSValueConst x) const
{
    auto it = componentNames.find(JS_VALUE_GET_PTR(x));
    if (it == componentNames.end())
        return nullopt;
    return it->second;
}

}
