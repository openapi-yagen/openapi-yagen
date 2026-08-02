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

}
