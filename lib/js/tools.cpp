#include "tools.h"

#include <format>
#include <ranges>

#include "../common/finalize.h"
#include "../common/std_tools.h"
#include "../logger/logger.h"

using namespace std;

namespace JS {
namespace {
LogFacade::Logger logger("JS::Tools");

// Best-effort JSValue -> string (its toString(), i.e. "Name: message" for an Error), without
// throwing - used to build a diagnostic message out of an exception value we're already in the
// process of reporting, where a further failure here shouldn't mask the original error.
string tryToCString(JSContext* ctx, const JSValue& v)
{
    auto s = JS_ToCString(ctx, v);
    if (!s)
        return {};
    string res(s);
    JS_FreeCString(ctx, s);
    return res;
}
}

[[noreturn]]
void rethrowException(JSContext* ctx, const JSValue& val, const std::string_view& msg)
{
    // JS_GetException clears the context's pending exception, so this is the only chance to
    // recover the real error text - same information quickjs-libc's own js_std_dump_error would
    // fprintf straight to stderr (and discard), kept here instead so it reaches whatever actually
    // catches this exception (the CLI's top-level error log, or the wasm bridge's `result.error`
    // shown in the playground - see the plan this was added from).
    auto exceptionVal = JS_GetException(ctx);
    finalize { JS_FreeValue(ctx, exceptionVal); };
    auto detail = tryToCString(ctx, exceptionVal);
    if (JS_IsError(ctx, exceptionVal)) {
        auto stackVal = JS_GetPropertyStr(ctx, exceptionVal, "stack");
        finalize { JS_FreeValue(ctx, stackVal); };
        if (!JS_IsUndefined(stackVal)) {
            auto stack = tryToCString(ctx, stackVal);
            if (!stack.empty())
                detail += "\n" + stack;
        }
    }
    throw runtime_error(detail.empty() ? string(msg) : format("{}. Error: {}", msg, detail));
}

void checkForException(JSContext* ctx, const JSValue& val, const std::string_view& msg)
{
    if (JS_IsException(val)) {
        rethrowException(ctx, val, msg);
    }
}

string jsValueToString(JSContext* ctx, const JSValue& v)
{
    if (!JS_IsString(v))
        throw runtime_error("<1e6e73a0> Value is not a string");
    size_t len;
    auto s = JS_ToCStringLen(ctx, &len, v);
    finalize { JS_FreeCString(ctx, s); };
    return string(s, len);
}

JSValue nodeToJSValue(JSContext* ctx, const Node& node)
{
    if (node.getIf<Node::Null>()) {
        return JS_NULL;
    } else if (auto v = node.getIf<Node::Bool>()) {
        return JS_NewBool(ctx, *v);
    } else if (auto v = node.getIf<Node::Int>()) {
        return JS_NewInt64(ctx, *v);
    } else if (auto v = node.getIf<Node::String>()) {
        return JS_NewStringLen(ctx, v->data(), v->size());
    } else if (auto v = node.getIf<Node::Vec>()) {
        auto arr = JS_NewArray(ctx);
        checkForException(ctx, arr, "<2f955021>");
        int i = 0;
        for (const auto& it : *v) {
            auto val = nodeToJSValue(ctx, it);
            JS_DefinePropertyValueUint32(ctx, arr, i++, val, JS_PROP_C_W_E);
        }
        return arr;
    } else if (auto v = node.getIf<Node::Map>()) {
        auto obj = JS_NewObject(ctx);
        checkForException(ctx, obj, "<3c59a839>");
        for (const auto& it : *v) {
            auto val = nodeToJSValue(ctx, it.second);
            JS_DefinePropertyValueStr(ctx, obj, it.first.c_str(), val, JS_PROP_C_W_E);
        }
        return obj;
    } else {
        throw runtime_error("<325f864a> Unsupported node type");
    }
}

void jsIterateObjectProps(
    JSContext* ctx, const JSValue& v, const std::function<void(const std::string& name, const JSValue& value)>& block)
{
    if (!JS_IsObject(v))
        throw runtime_error("<6396dcb7> Object expected");
    JSPropertyEnum* propEnum;
    uint32_t len;
    if (JS_GetOwnPropertyNames(ctx, &propEnum, &len, v, JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) < 0)
        throw runtime_error("<5d5199f0> Cannot enum props");
    finalize
    {
        for (uint32_t i = 0; i < len; i++) {
            JS_FreeAtom(ctx, propEnum[i].atom);
        }
        js_free(ctx, propEnum);
    };
    Node::Map res;
    for (uint32_t i = 0; i < len; i++) {
        auto propAtom = propEnum[i].atom;
        auto s = JS_AtomToCString(ctx, propAtom);
        finalize { JS_FreeCString(ctx, s); };
        auto propName = string(s);
        auto propValue = JS_GetProperty(ctx, v, propAtom);
        finalize { JS_FreeValue(ctx, propValue); };
        block(propName, propValue);
    }
}

Node jsValueToNode(JSContext* ctx, const JSValue& v)
{
    if (JS_IsNull(v) || JS_IsUndefined(v)) {
        return { Node::Null {} };
    } else if (JS_IsBool(v)) {
        auto res = JS_ToBool(ctx, v);
        if (res == -1)
            throw runtime_error("<01a84c55>");
        return { res ? true : false };
    } else if (JS_IsNumber(v)) {
        int64_t i;
        if (JS_ToInt64(ctx, &i, v) == -1)
            throw runtime_error("<905ba2d4>");
        return { i };
    } else if (JS_IsString(v)) {
        return { jsValueToString(ctx, v) };
    } else if (JS_IsArray(ctx, v)) {
        auto lengthAtom = JS_NewAtom(ctx, "length");
        finalize { JS_FreeAtom(ctx, lengthAtom); };
        auto lengthProp = JS_GetProperty(ctx, v, lengthAtom);
        finalize { JS_FreeValue(ctx, lengthProp); };
        uint64_t len;
        if (JS_ToIndex(ctx, &len, lengthProp) < 0)
            throw runtime_error("<d9acc18b>");
        Node::Vec res;
        for (uint64_t i = 0; i < len; i++) {
            auto it = JS_GetPropertyUint32(ctx, v, i);
            finalize { JS_FreeValue(ctx, it); };
            res.push_back(jsValueToNode(ctx, it));
        }
        return { res };
    } else if (JS_IsObject(v)) {
        Node::Map res;
        jsIterateObjectProps(ctx, v,
            [&](const auto& propName, const JSValue& propValue) { res[propName] = jsValueToNode(ctx, propValue); });
        return { res };
    } else if (JS_IsException(v)) {
        rethrowException(ctx, v, "<c9c2c575> JS exception");
    } else {
        throw runtime_error(format("<d05dbcae> Unsupported JS value: {}", JS_VALUE_GET_TAG(v)));
    }
}

void setObjProperty(JSContext* ctx, JSValue obj, const std::string& name, JSValue v)
{
    auto nameAtom = JS_NewAtomLen(ctx, name.c_str(), name.size());
    finalize { JS_FreeAtom(ctx, nameAtom); };
    if (JS_SetProperty(ctx, obj, nameAtom, v) == -1)
        throw runtime_error(format("<37565a00> Cannot set property: {}", name));
}

JSValueWrapper::JSValueWrapper(JSContext* ctx, const JSValue& value)
    : ctx(ctx)
    , v(value)
    , empty(false)
{
}

JSValueWrapper::~JSValueWrapper()
{
    if (!empty)
        JS_FreeValue(ctx, v);
}

JSValueWrapper::JSValueWrapper(const JSValueWrapper& w)
    : v(JS_DupValue(w.ctx, w.v))
    , ctx(w.ctx)
    , empty(false)
{
}

JSValueWrapper::JSValueWrapper(JSValueWrapper&& w)
    : v(std::move(w.v))
    , ctx(w.ctx)
    , empty(false)
{
    w.empty = true;
}

void setObjFunction(JSContext* ctx, JSValue obj, const std::string& name, JSCFunction* func)
{
    auto f = JS_NewCFunction(ctx, func, name.c_str(), name.size());
    setObjProperty(ctx, obj, name, f);
}

JSValue jsFunc(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic, JSValue* data)
{
    const auto& unpackedThis = *jsValueToPtr<const FuncType>(*data);
    return runAndCatchExceptions(ctx, [&] {
        auto args = views::counted(argv, argc) | views::transform([ctx](auto a) { return jsValueToNode(ctx, a); })
            | toVector();
        return nodeToJSValue(ctx, unpackedThis(args));
    });
}

void setObjFunction(JSContext* ctx, JSValue obj, const std::string& name, const FuncType& func)
{
    setObjFunction(ctx, obj, name, jsFunc, &func);
}

}
