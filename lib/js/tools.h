#pragma once

#include <functional>
#include <stdexcept>
#include <string_view>

#include <quickjs/quickjs.h>

#include "../common/function.h"
#include "../common/node.h"

namespace JS {

static const int JS_TAG_PTR = 100;

class JSValueWrapper {
public:
    JSValueWrapper(JSContext* ctx, const JSValue& value);
    ~JSValueWrapper();
    JSValueWrapper(const JSValueWrapper&);
    JSValueWrapper(JSValueWrapper&&);
    JSValueWrapper& operator=(const JSValueWrapper&) = delete;

    const JSValue& operator*() const { return v; }

private:
    JSContext* ctx;
    JSValue v;
    bool empty;
};

struct WrapParams {
    JSContext* ctx;
};
inline WrapParams wrap(JSContext* ctx) { return { ctx }; }
inline JSValueWrapper operator|(const JSValue& v, const WrapParams& params) { return JSValueWrapper(params.ctx, v); }

template <typename Block>
JSValue runAndCatchExceptions(JSContext* ctx, const Block& block)
{
    try {
        return block();
    } catch (const std::exception& e) {
        return JS_ThrowInternalError(ctx, "%s", e.what());
    }
}

void checkForException(JSContext* ctx, const JSValue& val, const std::string_view& msg);

template <typename T>
JSValue ptrToJSValue(T* ptr)
{
    // TODO: Try use JS_SetOpaque

    // JS_MKPTR/JS_VALUE_GET_PTR/JS_VALUE_GET_TAG (not direct .tag/.u.ptr field access) are the
    // portable way to stash a raw pointer in a JSValue: quickjs.h picks JSValue's actual
    // representation per target (a {JSValueUnion u; int64_t tag;} struct on 64-bit-pointer
    // platforms, a NaN-boxed uint64_t on 32-bit-pointer ones, e.g. wasm32 or i686) - direct field
    // access only compiles against the former.
    return JS_MKPTR(JS_TAG_PTR, (void*)ptr);
}

template <typename T>
T* jsValueToPtr(const JSValue& v)
{
    if (JS_VALUE_GET_TAG(v) != JS_TAG_PTR)
        throw std::runtime_error("<1d2786bb>");
    return (T*)JS_VALUE_GET_PTR(v);
}

std::string jsValueToString(JSContext* ctx, const JSValue& v);
JSValue nodeToJSValue(JSContext* ctx, const Node& node);
Node jsValueToNode(JSContext* ctx, const JSValue& v);

void setObjProperty(JSContext* ctx, JSValue obj, const std::string& name, JSValue v);

template <typename Opts>
void setObjFunction(JSContext* ctx, JSValue obj, const std::string& name, JSCFunctionData* func, Opts* opts)
{
    auto optsVal = ptrToJSValue(opts);
    auto f = JS_NewCFunctionData(ctx, func, 0, 0, 1, &optsVal);
    setObjProperty(ctx, obj, name, f);
}

void setObjFunction(JSContext* ctx, JSValue obj, const std::string& name, JSCFunction* func);

/// WARNING: not own func
void setObjFunction(JSContext* ctx, JSValue obj, const std::string& name, const FuncType& func);

void jsIterateObjectProps(
    JSContext* ctx, const JSValue& v, const std::function<void(const std::string& name, const JSValue& value)>& block);

}
