#include "openapi_generator.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstring>
#include <map>
#include <set>
#include <stdexcept>
#include <utility>

#include <quickjs/quickjs-libc.h>
#include <quickjs/quickjs.h>

#include "../common/finalize.h"
#include "../common/node_walker.h"
#include "../common/std_tools.h"
#include "../common/string_tools.h"
#include "../common/yaml_or_json_parser.h"
#include "../filesystem/file_reader.h"
#include "../filesystem/file_writer.h"
#include "../filesystem/tools.h"
#include "../js/executor.h"
#include "../js/tools.h"
#include "../logger/logger.h"
#include "../openapi/filter.h"
#include "../openapi/resolve.h"
#include "../openapi/v3/reader.h"
#include "../openapi/version_convert.h"
#include "../templates/template_renderer.h"
#include "functions.h"
#include "generator_metadata.h"
#include "openapi_js_bridge.h"
#include "spec_file.h"

using namespace std;
using namespace std::ranges;
using namespace JS;

namespace Generator {

namespace {
LogFacade::Logger logger("OpenApiGenerator");

map<string, string> parseVars(const vector<string>& vars)
{
    map<string, string> res;
    for (const auto& s : vars) {
        auto p = s.find("=");
        if (p == string::npos)
            throw runtime_error(format(
                "<2f3ad1ca> Invalid variable syntax: two values splitted with \"=\" expected in string \"{}\"", s));
        auto varName = s.substr(0, p) | trim();
        auto varValue = s.substr(p + 1, s.size() - p) | trim();
        if (varName.empty())
            throw runtime_error("<5de5573d> Variable name required");
        res[varName] = varValue;
    }
    return res;
}

Node getFinalVars(const vector<string>& vars, const GeneratorMetadata& metadata)
{
    Node::Map res;
    set<string> definedVars;
    auto parsedVars = parseVars(vars);
    for (const auto& varDescr : metadata.variables) {
        auto it = parsedVars.find(varDescr.name);
        definedVars.insert(varDescr.name);
        string varValue;
        if (it == parsedVars.end()) {
            if (varDescr.required)
                throw runtime_error(format("<1e9c49a1> Variable required: {}{}", varDescr.name,
                                           (varDescr.description ? " - " + *varDescr.description : "")));
            if (!varDescr.defaultValue)
                continue;
            varValue = *varDescr.defaultValue;
        } else {
            varValue = it->second;
        }
        logger.debug("<29db917f> Variable: {}={}", varDescr.name, varValue);
        res[varDescr.name] = { varValue };
    }

    for (const auto& p : parsedVars) {
        if (definedVars.find(p.first) == definedVars.end())
            throw runtime_error(format("<3ca00dee> Variable \"{}\" profided but not defined in metadata", p.first));
    }

    return { res };
}

// Determines what OpenAPI version the generator was written for (GeneratorMetadata::openApiVersion,
// default "3.0" - matching every generator that predates this field) and what version the input
// spec actually declares, then converts the spec to the generator's version if they differ. This
// both unblocks generators written for one version being fed a spec in another, and doubles as
// the spec's structural validation (see OpenApi::V3::Read) - there's no separate JSON-schema
// validation step anymore.
struct VersionedSpec {
    Node node;
    OpenApi::OpenApiVersion version;
};

VersionedSpec convertToGeneratorVersion(const GeneratorMetadata& metadata, const Node& specNode)
{
    auto detected = OpenApi::detectVersion(specNode);
    if (!detected)
        throw runtime_error("<9189d16e> Cannot determine the spec's OpenAPI version - expected a top-level "
                             "\"openapi\" (3.x) or \"swagger\" (2.0) field with a recognized value");

    auto targetStr = metadata.openApiVersion.value_or("3.0");
    auto target = OpenApi::parseVersionString(targetStr);
    if (!target)
        throw runtime_error(
            format("<b3983ba0> Generator declares an unrecognized openApiVersion \"{}\"", targetStr));
    if (!OpenApi::isV3(*target))
        // Swagger 2.0's document shape (flat non-body parameters, a single response `schema`,
        // body/formData parameters instead of requestBody, ...) is too different from what the JS
        // bridge's raw+overlay pattern assumes (OAS 3.x's content maps, nested schemas, ...) for
        // generation to work if fed 2.0-shaped JSON directly - 2.0 is only supported as a spec
        // *input* (auto-converted up to an OAS 3.x target above) and as the `convert` command's
        // output, never as a generator's own declared version.
        throw runtime_error(format("<8725d14e> Generator declares openApiVersion \"{}\" - only 3.0/3.1/3.2 are "
                                    "supported as a generation target (2.0 works as a spec input, converted up)",
                                    targetStr));

    if (*detected == *target)
        return { specNode, *target };

    logger.info("<eb4e4574> Converting spec from OpenAPI {} to {} (generator's declared openApiVersion)",
                OpenApi::toVersionString(*detected), OpenApi::toVersionString(*target));
    return { OpenApi::convertVersion(specNode, *detected, *target), *target };
}

GeneratorMetadata readMetadata(const FS::FileReaderPtr& fileReader, const string& metadataPath)
{
    try {
        auto metadataNode = parseYamlOrJsonToNode(fileReader->read(metadataPath));
        return parseGeneratorMetadata(NodeWalker(metadataNode));
    } catch (const exception& e) {
        throw runtime_error(
            format("<c20e9799> Cannot read generator metadata from file \"{}\". Error: {}", metadataPath, e.what()));
    }
}

Functions mapJSFuncsToTemplateFuncs(JSContext* ctx, const JSValue& v)
{
    Functions res;
    jsIterateObjectProps(ctx, v, [&](const string& propName, const JSValue& propValue) {
        auto wrappedPropValue = JS_DupValue(ctx, propValue) | wrap(ctx);
        Function func;
        func.name = propName;
        func.func = [ctx, wrappedPropValue, propName](const Node::Vec& args) {
            auto jsArgs = args | mapToVector([&](const auto& n) { return nodeToJSValue(ctx, n); });
            finalize
            {
                for (const auto& v : jsArgs) {
                    JS_FreeValue(ctx, v);
                }
            };
            auto globalObj = JS_GetGlobalObject(ctx) | wrap(ctx);

            if (logger.isLevelEnabled(LogFacade::LogLevel::DEBUG)) {
                logger.trace("<16e600d1> Call JS func: name={}, args={}", propName, args | joinToString(","));
            }
            JSValue result = JS_Call(ctx, *wrappedPropValue, *globalObj, jsArgs.size(), jsArgs.data());
            auto resultNode = jsValueToNode(ctx, result);
            if (logger.isLevelEnabled(LogFacade::LogLevel::DEBUG)) {
                logger.trace("<607e470e> JS func call result: name={}, result={}", propName, resultNode | toString());
            }
            return resultNode;
        };
        res.push_back(std::move(func));
    });
    return res;
}

int32_t jsArrayLength(JSContext* ctx, JSValueConst v)
{
    if (!JS_IsArray(ctx, v))
        return 0;
    auto lenVal = JS_GetPropertyStr(ctx, v, "length");
    int32_t len = 0;
    JS_ToInt32(ctx, &len, lenVal);
    JS_FreeValue(ctx, lenVal);
    return len;
}

bool jsObjectHasOwnKeys(JSContext* ctx, JSValueConst v)
{
    if (!JS_IsObject(v))
        return false;
    JSPropertyEnum* propEnum;
    uint32_t len;
    if (JS_GetOwnPropertyNames(ctx, &propEnum, &len, v, JS_GPN_STRING_MASK) < 0)
        return false;
    for (uint32_t i = 0; i < len; i++)
        JS_FreeAtom(ctx, propEnum[i].atom);
    js_free(ctx, propEnum);
    return len > 0;
}

// Mirrors OpenApi::kindOf's precedence (lib/openapi/schema.cpp) but reads only shallow, top-level
// properties of the JS schema object directly - never the full nested content, unlike a
// jsValueToNode round-trip - so it stays safe on a (possibly self-referential) schema built by
// OpenApiJsGraphBuilder, where a full conversion back to Node would recurse forever. Keep this in
// sync with OpenApi::kindOf if that precedence ever changes.
string kindOfShallow(JSContext* ctx, JSValueConst v)
{
    // `type` is a plain string for a spec/generator on OAS 3.0's dialect, but a JSON Schema type
    // array (e.g. ["string", "null"]) for one on OAS 3.1/3.2's - accept either shape.
    auto hasType = [&](const char* wanted) {
        auto val = JS_GetPropertyStr(ctx, v, "type");
        finalize { JS_FreeValue(ctx, val); };
        if (JS_IsString(val))
            return jsValueToString(ctx, val) == wanted;
        if (auto len = jsArrayLength(ctx, val); len > 0) {
            for (uint32_t i = 0; i < (uint32_t)len; i++) {
                auto item = JS_GetPropertyUint32(ctx, val, i);
                finalize { JS_FreeValue(ctx, item); };
                if (JS_IsString(item) && jsValueToString(ctx, item) == wanted)
                    return true;
            }
        }
        return false;
    };
    auto getArrLen = [&](const char* key) {
        auto val = JS_GetPropertyStr(ctx, v, key);
        auto len = jsArrayLength(ctx, val);
        JS_FreeValue(ctx, val);
        return len;
    };
    auto getObjHasKeys = [&](const char* key) {
        auto val = JS_GetPropertyStr(ctx, v, key);
        auto has = jsObjectHasOwnKeys(ctx, val);
        JS_FreeValue(ctx, val);
        return has;
    };

    if (getArrLen("enum") > 0)
        return "Enum";
    if (getArrLen("allOf") > 0)
        return "AllOf";
    if (getArrLen("oneOf") > 0)
        return "OneOf";
    if (getArrLen("anyOf") > 0)
        return "AnyOf";
    if (hasType("array"))
        return "Array";
    if (getObjHasKeys("properties"))
        return "Object";

    auto apVal = JS_GetPropertyStr(ctx, v, "additionalProperties");
    bool hasAdditionalProperties = !JS_IsUndefined(apVal);
    JS_FreeValue(ctx, apVal);
    if (hasType("object") || hasAdditionalProperties)
        return "Map";

    if (hasType("string") || hasType("integer") || hasType("number") || hasType("boolean"))
        return "Primitive";
    return "Unknown";
}

JSValue kindOfBuiltin(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv)
{
    return runAndCatchExceptions(ctx, [&] {
        if (argc < 1)
            throw runtime_error("<6214d2e5> kindOf requires 1 argument (schema: object)");
        auto kind = kindOfShallow(ctx, argv[0]);
        return JS_NewStringLen(ctx, kind.data(), kind.size());
    });
}

// Peels through a chain of single-branch oneOf/anyOf/allOf wrappers (the common "attach a sibling
// `description` next to a `$ref`" idiom, or a .NET/Swashbuckle-style `allOf: [$ref X]`) down to the
// schema that actually determines the wire shape. Returns the unwrapped schema's own JSValue (a
// dup of the original object reached while walking down, never a copy), so nameOf()/kindOf() still
// work on the result exactly as they would on the schema reached by hand. Used to be duplicated
// (as `unwrapSingleBranch`) in every generator's own operations.js.
JSValue unwrapSchemaValue(JSContext* ctx, JSValueConst v)
{
    JSValue current = JS_DupValue(ctx, v);
    for (;;) {
        auto kind = kindOfShallow(ctx, current);
        const char* arrKey = kind == "OneOf" ? "oneOf" : kind == "AnyOf" ? "anyOf" : kind == "AllOf" ? "allOf" : nullptr;
        if (!arrKey)
            return current;
        auto arr = JS_GetPropertyStr(ctx, current, arrKey);
        auto len = jsArrayLength(ctx, arr);
        if (len != 1) {
            JS_FreeValue(ctx, arr);
            return current;
        }
        auto next = JS_GetPropertyUint32(ctx, arr, 0);
        JS_FreeValue(ctx, arr);
        JS_FreeValue(ctx, current);
        current = next;
    }
}

JSValue unwrapSchemaBuiltin(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv)
{
    return runAndCatchExceptions(ctx, [&] {
        if (argc < 1)
            throw runtime_error("<01534acc> unwrapSchema requires 1 argument (schema: object)");
        return unwrapSchemaValue(ctx, argv[0]);
    });
}

// Only leaf/scalar constraint fields are read - none of these are ever nested schemas, so no
// cycle-safety concern here at all (unlike kindOf's shape-classifying fields).
JSValue constraintsOfBuiltin(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv)
{
    return runAndCatchExceptions(ctx, [&] {
        if (argc < 1)
            throw runtime_error("<6c9f85fa> constraintsOf requires 1 argument (schema: object)");
        auto obj = JS_NewObject(ctx);
        checkForException(ctx, obj, "<d3e4f5a6> Cannot create object");
        for (const char* key : { "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
                                 "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties",
                                 "pattern", "uniqueItems" }) {
            auto val = JS_GetPropertyStr(ctx, argv[0], key);
            if (!JS_IsUndefined(val))
                setObjProperty(ctx, obj, key, val);
            else
                JS_FreeValue(ctx, val);
        }
        return obj;
    });
}

JSValue nameOfBuiltin(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv, int magic, JSValue* data)
{
    return runAndCatchExceptions(ctx, [&] {
        auto& builder = *jsValueToPtr<Generator::OpenApiJsGraphBuilder>(*data);
        if (argc < 1)
            throw runtime_error("<e4f5a6b7> nameOf requires 1 argument (x: object)");
        auto name = builder.nameOf(argv[0]);
        if (!name)
            return JS_NULL;
        return JS_NewStringLen(ctx, name->data(), name->size());
    });
}

struct CollectOperationsCtx {
    Generator::OpenApiJsGraphBuilder* builder;
    const vector<OpenApi::ResolvedOperation>* operations;
};

JSValue collectOperationsBuiltin(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv, int magic,
                                 JSValue* data)
{
    return runAndCatchExceptions(ctx, [&] {
        auto& c = *jsValueToPtr<CollectOperationsCtx>(*data);
        return Generator::buildOperationsArray(ctx, *c.builder, *c.operations);
    });
}

// True if `code` looks like a 3-digit "2xx" HTTP status code string.
bool isSuccessStatusCode(const string& code)
{
    return code.size() == 3 && code[0] == '2' && isdigit(static_cast<unsigned char>(code[1]))
        && isdigit(static_cast<unsigned char>(code[2]));
}

// Picks the response every generator's own buildResponse()-style helper otherwise re-derives by
// hand: the first declared 2xx status code (sorted), falling back to "default", or null if
// `responses` has neither. Reads `responses` (an operation's already-deref'd `.responses` object,
// or `schema.paths.<path>.<method>.responses`) directly via JSValue property access rather than a
// Node round-trip, like kindOf/constraintsOf above - the picked response's nested schema may still
// need nameOf()/kindOf() to work on it, which requires preserving its exact JS object identity.
JSValue firstSuccessResponseBuiltin(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv)
{
    return runAndCatchExceptions(ctx, [&] {
        if (argc < 1)
            throw runtime_error("<a45c21b2> firstSuccessResponse requires 1 argument (responses: object)");
        if (!JS_IsObject(argv[0]))
            return JS_NULL;

        JSPropertyEnum* propEnum;
        uint32_t len;
        if (JS_GetOwnPropertyNames(ctx, &propEnum, &len, argv[0], JS_GPN_STRING_MASK) < 0)
            throw runtime_error("<76add204> Cannot enumerate responses object");
        vector<string> codes;
        codes.reserve(len);
        for (uint32_t i = 0; i < len; i++) {
            auto cstr = JS_AtomToCString(ctx, propEnum[i].atom);
            codes.emplace_back(cstr);
            JS_FreeCString(ctx, cstr);
            JS_FreeAtom(ctx, propEnum[i].atom);
        }
        js_free(ctx, propEnum);

        vector<string> successCodes;
        for (const auto& c : codes)
            if (isSuccessStatusCode(c))
                successCodes.push_back(c);
        std::sort(successCodes.begin(), successCodes.end());

        string chosenCode;
        if (!successCodes.empty())
            chosenCode = successCodes.front();
        else if (std::find(codes.begin(), codes.end(), "default") != codes.end())
            chosenCode = "default";
        else
            return JS_NULL;

        auto result = JS_NewObject(ctx);
        checkForException(ctx, result, "<5cc383dc> Cannot create object");
        setObjProperty(ctx, result, "statusCode", JS_NewStringLen(ctx, chosenCode.data(), chosenCode.size()));
        setObjProperty(ctx, result, "response", JS_GetPropertyStr(ctx, argv[0], chosenCode.c_str()));
        return result;
    });
}

// Recursively merges `schema`'s own `properties`/`required` with every (possibly itself allOf-
// bearing) branch of `schema.allOf`, into a single flat `{properties, required}` - every
// generator handling allOf otherwise hand-rolls a one-level-only version of this same merge.
// Merged property values keep the exact JS object identity of wherever they were declared (a
// direct assignment of the branch's own property JSValue, never a copy/round-trip), so nameOf()/
// kindOf() still work on them afterwards - e.g. a merged-in property that's a $ref to a named
// schema still resolves via nameOf.
void flattenAllOfInto(JSContext* ctx, JSValueConst schemaVal, JSValue propertiesObj, vector<string>& required,
                      set<string>& seenRequired)
{
    auto allOfVal = JS_GetPropertyStr(ctx, schemaVal, "allOf");
    if (JS_IsArray(ctx, allOfVal)) {
        auto len = jsArrayLength(ctx, allOfVal);
        for (int32_t i = 0; i < len; i++) {
            auto branch = JS_GetPropertyUint32(ctx, allOfVal, (uint32_t)i);
            flattenAllOfInto(ctx, branch, propertiesObj, required, seenRequired);
            JS_FreeValue(ctx, branch);
        }
    }
    JS_FreeValue(ctx, allOfVal);

    auto propsVal = JS_GetPropertyStr(ctx, schemaVal, "properties");
    if (JS_IsObject(propsVal)) {
        jsIterateObjectProps(ctx, propsVal, [&](const string& name, const JSValue& value) {
            setObjProperty(ctx, propertiesObj, name, JS_DupValue(ctx, value));
        });
    }
    JS_FreeValue(ctx, propsVal);

    auto reqVal = JS_GetPropertyStr(ctx, schemaVal, "required");
    if (JS_IsArray(ctx, reqVal)) {
        auto len = jsArrayLength(ctx, reqVal);
        for (int32_t i = 0; i < len; i++) {
            auto item = JS_GetPropertyUint32(ctx, reqVal, (uint32_t)i);
            if (JS_IsString(item)) {
                auto name = jsValueToString(ctx, item);
                if (seenRequired.insert(name).second)
                    required.push_back(name);
            }
            JS_FreeValue(ctx, item);
        }
    }
    JS_FreeValue(ctx, reqVal);
}

JSValue flattenAllOfBuiltin(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv)
{
    return runAndCatchExceptions(ctx, [&] {
        if (argc < 1)
            throw runtime_error("<8ed774c8> flattenAllOf requires 1 argument (schema: object)");

        auto propertiesObj = JS_NewObject(ctx);
        checkForException(ctx, propertiesObj, "<d3ceb1a8> Cannot create object");
        vector<string> required;
        set<string> seenRequired;
        flattenAllOfInto(ctx, argv[0], propertiesObj, required, seenRequired);

        auto requiredArr = JS_NewArray(ctx);
        checkForException(ctx, requiredArr, "<bf5da566> Cannot create array");
        for (size_t i = 0; i < required.size(); i++)
            JS_DefinePropertyValueUint32(ctx, requiredArr, (uint32_t)i,
                                         JS_NewStringLen(ctx, required[i].data(), required[i].size()), JS_PROP_C_W_E);

        auto result = JS_NewObject(ctx);
        checkForException(ctx, result, "<f48a424f> Cannot create object");
        setObjProperty(ctx, result, "properties", propertiesObj);
        setObjProperty(ctx, result, "required", requiredArr);
        return result;
    });
}

// Returns the first meaningful (non-"null") value of a schema's `type` keyword, whether the
// source spec's dialect wrote it as a single string (OAS 3.0) or a type array (OAS 3.1/3.2) -
// classifyVariantDispatch below only ever needs one concrete scalar type name.
optional<string> primaryTypeOf(JSContext* ctx, JSValueConst v)
{
    auto val = JS_GetPropertyStr(ctx, v, "type");
    finalize { JS_FreeValue(ctx, val); };
    if (JS_IsString(val)) {
        auto s = jsValueToString(ctx, val);
        return s == "null" ? nullopt : optional<string>(s);
    }
    if (auto len = jsArrayLength(ctx, val); len > 0) {
        for (uint32_t i = 0; i < (uint32_t)len; i++) {
            auto item = JS_GetPropertyUint32(ctx, val, i);
            finalize { JS_FreeValue(ctx, item); };
            if (JS_IsString(item)) {
                auto s = jsValueToString(ctx, item);
                if (s != "null")
                    return s;
            }
        }
    }
    return nullopt;
}

// Classifies a oneOf/anyOf variant by the shape it takes on the wire (what a target language's
// runtime dispatcher can actually branch on): "object"/"array"/"string"/"number"/"boolean"/"any"
// (an unconstrained schema matching every possible JSON value, e.g. a bare `{}`), or "" when the
// variant's shape can't be resolved at all (e.g. a nested oneOf/anyOf - not supported as a union
// variant).
string classifyVariantDispatch(JSContext* ctx, JSValueConst variant)
{
    auto kind = kindOfShallow(ctx, variant);
    if (kind == "Object" || kind == "Map" || kind == "AllOf")
        return "object";
    if (kind == "Array")
        return "array";
    if (kind == "Enum") {
        auto t = primaryTypeOf(ctx, variant);
        return (t == "integer" || t == "number") ? "number" : "string";
    }
    if (kind == "Primitive") {
        auto t = primaryTypeOf(ctx, variant);
        if (t == "string")
            return "string";
        if (t == "integer" || t == "number")
            return "number";
        if (t == "boolean")
            return "boolean";
        return "";
    }
    if (kind == "Unknown")
        return "any";
    return "";
}

// A variant's own declared property names/required list, flattening allOf first (via the same
// flattenAllOfInto used by flattenAllOf() above) so an AllOf-kind variant - which has no
// `properties`/`required` of its own, only on its allOf branches - is compared by its actual
// merged field set. `propertyNames` keeps declaration order (matters for
// findUniqueDistinguishingField's "first declared, not just any" tie-break); `propertySet` is
// just for O(1) membership checks.
struct DeclaredFields {
    vector<string> propertyNames;
    set<string> propertySet;
    vector<string> required;
};

DeclaredFields declaredFieldsOf(JSContext* ctx, JSValueConst variant)
{
    DeclaredFields result;
    JSValue propsVal;
    if (kindOfShallow(ctx, variant) == "AllOf") {
        propsVal = JS_NewObject(ctx);
        checkForException(ctx, propsVal, "<db0eb1c8> Cannot create object");
        set<string> seenRequired;
        flattenAllOfInto(ctx, variant, propsVal, result.required, seenRequired);
    } else {
        propsVal = JS_GetPropertyStr(ctx, variant, "properties");
        auto reqVal = JS_GetPropertyStr(ctx, variant, "required");
        if (JS_IsArray(ctx, reqVal)) {
            auto len = jsArrayLength(ctx, reqVal);
            for (int32_t i = 0; i < len; i++) {
                auto item = JS_GetPropertyUint32(ctx, reqVal, (uint32_t)i);
                if (JS_IsString(item))
                    result.required.push_back(jsValueToString(ctx, item));
                JS_FreeValue(ctx, item);
            }
        }
        JS_FreeValue(ctx, reqVal);
    }
    if (JS_IsObject(propsVal)) {
        jsIterateObjectProps(ctx, propsVal, [&](const string& name, const JSValue&) {
            result.propertyNames.push_back(name);
            result.propertySet.insert(name);
        });
    }
    JS_FreeValue(ctx, propsVal);
    return result;
}

// Finds a property name of `variant` that no other object-shaped variant in `objectVariants` also
// declares - what a generated deserializer uses to tell apart multiple object-shaped oneOf/anyOf
// variants that have no discriminator. Prefers one of `variant`'s `required` fields (a stronger
// signal: the property is guaranteed present whenever this variant occurs), falling back to any
// of its other declared-but-optional properties - the runtime check is just "is this key present
// in the JSON object", which works just as well for an optional field the payload happens to
// include as for a required one. Compares variants by JS object identity (a variant may equal
// itself only), matching nameOf()'s own identity-based lookups.
optional<string> findUniqueDistinguishingField(JSContext* ctx, JSValueConst variant, const vector<JSValueConst>& objectVariants)
{
    auto fields = declaredFieldsOf(ctx, variant);
    vector<DeclaredFields> others;
    for (auto v : objectVariants) {
        if (JS_VALUE_GET_PTR(v) == JS_VALUE_GET_PTR(variant))
            continue;
        others.push_back(declaredFieldsOf(ctx, v));
    }
    auto isUnique = [&](const string& field) {
        for (const auto& o : others)
            if (o.propertySet.count(field))
                return false;
        return true;
    };
    for (const auto& f : fields.required)
        if (isUnique(f))
            return f;
    for (const auto& f : fields.propertyNames)
        if (isUnique(f))
            return f;
    return nullopt;
}

// Coerces a scalar (string/number/boolean) JS value into a canonical string form for comparing
// distinctness across variants - this is a dispatch KEY, not a wire-format serialization, so
// there's no need to preserve the original JSON type, only to give each distinct literal value a
// stable, comparable string. Returns nullopt for anything else (object/array/null/undefined) -
// only a scalar can be a `const`/single-`enum`-entry literal in the first place.
optional<string> jsScalarToCanonicalString(JSContext* ctx, JSValueConst v)
{
    if (JS_IsString(v))
        return jsValueToString(ctx, v);
    if (JS_IsNumber(v) || JS_IsBool(v)) {
        auto cstr = JS_ToCString(ctx, v);
        string s(cstr);
        JS_FreeCString(ctx, cstr);
        return s;
    }
    return nullopt;
}

// If `propSchema` constrains its value to exactly one literal - a `const`, or a single-entry
// `enum` (after dropping any `null` entry, the same "not a real member" treatment the Go/Kotlin/
// TypeScript/... generators' own enum-registration JS already gives a nullable enum's `null`
// entry) - returns its canonical string form (see jsScalarToCanonicalString). Used by
// findFieldValueDispatch below to find a "field-value" discriminator: a property name every
// candidate variant declares, each pinning it to a different literal (e.g. `kind: {enum:
// [circle]}` vs `kind: {enum: [square]}`), without a formal `discriminator` keyword.
optional<string> singleLiteralValueOf(JSContext* ctx, JSValueConst propSchema)
{
    auto constVal = JS_GetPropertyStr(ctx, propSchema, "const");
    bool hasConst = !JS_IsUndefined(constVal);
    optional<string> result;
    if (hasConst)
        result = jsScalarToCanonicalString(ctx, constVal);
    JS_FreeValue(ctx, constVal);
    if (hasConst)
        return result;

    auto enumVal = JS_GetPropertyStr(ctx, propSchema, "enum");
    if (JS_IsArray(ctx, enumVal)) {
        vector<string> nonNullEntries;
        bool sawNonScalar = false;
        auto len = jsArrayLength(ctx, enumVal);
        for (int32_t i = 0; i < len && !sawNonScalar; i++) {
            auto item = JS_GetPropertyUint32(ctx, enumVal, (uint32_t)i);
            if (!JS_IsNull(item)) {
                auto canon = jsScalarToCanonicalString(ctx, item);
                if (canon)
                    nonNullEntries.push_back(*canon);
                else
                    sawNonScalar = true;
            }
            JS_FreeValue(ctx, item);
        }
        JS_FreeValue(ctx, enumVal);
        if (!sawNonScalar && nonNullEntries.size() == 1)
            return nonNullEntries[0];
        return nullopt;
    }
    JS_FreeValue(ctx, enumVal);
    return nullopt;
}

// A "field-value" resolution for the subset of object variants findUniqueDistinguishingField
// couldn't tell apart by property *presence* alone (every property they declare is also declared
// by some sibling). `field` is shared by every one of `unresolvedVariants` bar at most one (the
// same "at most one may be left as the trailing shape-based fallback" rule
// resolveUnionDispatchBuiltin's presence-based pass already follows); `values[i]` is that
// variant's own literal for `field`, or nullopt for the (at most one) fallback variant.
struct FieldValueDispatch {
    string field;
    vector<optional<string>> values;
};

// AllOf-shaped variants are deliberately not flattened here the way declaredFieldsOf flattens them
// for presence-based matching - out of scope for this pass; such a variant just won't match any
// candidate property (JS_GetPropertyStr(variant, "properties") finds nothing on an AllOf node, its
// properties live on its allOf branches instead) and falls through to the pre-existing error below
// exactly as if this pass didn't exist, so it's a missed opportunity, not an incorrect result.
optional<FieldValueDispatch> findFieldValueDispatch(JSContext* ctx, const vector<JSValueConst>& unresolvedVariants)
{
    if (unresolvedVariants.size() < 2)
        return nullopt;

    // Candidate property names come from the first unresolved variant, in its own declaration
    // order (for a deterministic pick) - any property common to enough of the set must appear
    // there too, so nothing is missed by not also scanning every other variant's own property list.
    auto firstFields = declaredFieldsOf(ctx, unresolvedVariants[0]);
    for (const auto& candidate : firstFields.propertyNames) {
        vector<optional<string>> values;
        set<string> seenLiterals;
        int32_t withoutLiteralCount = 0;
        bool duplicateLiteral = false;
        for (auto variant : unresolvedVariants) {
            auto propsVal = JS_GetPropertyStr(ctx, variant, "properties");
            auto propSchema = JS_GetPropertyStr(ctx, propsVal, candidate.c_str());
            optional<string> literal;
            if (JS_IsObject(propSchema))
                literal = singleLiteralValueOf(ctx, propSchema);
            JS_FreeValue(ctx, propSchema);
            JS_FreeValue(ctx, propsVal);
            if (!literal) {
                withoutLiteralCount++;
                values.push_back(nullopt);
                continue;
            }
            if (seenLiterals.count(*literal)) {
                duplicateLiteral = true;
                break;
            }
            seenLiterals.insert(*literal);
            values.push_back(literal);
        }
        if (!duplicateLiteral && withoutLiteralCount <= 1)
            return FieldValueDispatch { candidate, values };
    }
    return nullopt;
}

// Resolves the dispatch classification for every variant of an undiscriminated oneOf/anyOf -
// sibling to resolveDiscriminator() below, for the case a spec's oneOf/anyOf has no discriminator
// at all. What a generator targeting a language with algebraic/discriminated-union support but no
// native support for OpenAPI's undiscriminated unions (e.g. Kotlin's sealed interfaces) needs to
// build a runtime deserializer: classify each variant's wire shape as object/array/string/number/
// boolean/any (see classifyVariantDispatch above), and - for 2+ object-shaped variants - find each
// one either a property no sibling object-variant also declares ("field-name" dispatch - see
// findUniqueDistinguishingField), or, failing that, a property every one of them shares but pins
// to a different literal value each ("field-value" dispatch - see findFieldValueDispatch),
// allowing at most one property-less/value-less variant as a trailing shape-only fallback either
// way. Throws a descriptive error (left for the caller's own strict/permissive handling - see
// withResilience in generator JS) if a variant's shape can't be classified at all, if more than one
// variant shares a non-object dispatch kind, or if 2+ object variants still can't be told apart
// after both passes. Returns variants in the SAME order as `schema.oneOf`/`schema.anyOf` - no
// reordering: a caller wanting the "field-less fallback sorts last" order (see model_union.kt.j2)
// does that itself, since only it knows how to re-zip the result against other per-variant data
// (e.g. a generated wrapper type name) already computed alongside it. Returns null (not every
// schema is a oneOf/anyOf at all) rather than throwing, same as resolveDiscriminator.
JSValue resolveUnionDispatchBuiltin(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv)
{
    return runAndCatchExceptions(ctx, [&] {
        if (argc < 1)
            throw runtime_error("<394d7fec> resolveUnionDispatch requires 1 argument (schema: object)");
        auto schemaVal = argv[0];

        auto variantsVal = JS_GetPropertyStr(ctx, schemaVal, "oneOf");
        if (!JS_IsArray(ctx, variantsVal)) {
            JS_FreeValue(ctx, variantsVal);
            variantsVal = JS_GetPropertyStr(ctx, schemaVal, "anyOf");
        }
        if (!JS_IsArray(ctx, variantsVal)) {
            JS_FreeValue(ctx, variantsVal);
            return JS_NULL;
        }

        auto len = jsArrayLength(ctx, variantsVal);
        vector<JSValueWrapper> variants;
        variants.reserve(len);
        for (int32_t i = 0; i < len; i++)
            variants.emplace_back(ctx, JS_GetPropertyUint32(ctx, variantsVal, (uint32_t)i));
        JS_FreeValue(ctx, variantsVal);

        vector<string> dispatchKinds(len);
        for (int32_t i = 0; i < len; i++) {
            auto k = classifyVariantDispatch(ctx, *variants[i]);
            if (k.empty())
                throw runtime_error(
                    format("<31045be5> oneOf/anyOf variant #{} has no recognizable JSON shape to dispatch on "
                           "(nested oneOf/anyOf variants aren't supported)",
                           i + 1));
            dispatchKinds[i] = k;
        }

        vector<int32_t> objectIndices;
        for (int32_t i = 0; i < len; i++)
            if (dispatchKinds[i] == "object")
                objectIndices.push_back(i);

        vector<optional<string>> dispatchFields(len);
        vector<optional<string>> dispatchValues(len);
        if (objectIndices.size() > 1) {
            vector<JSValueConst> objectVariants;
            for (auto i : objectIndices)
                objectVariants.push_back(*variants[i]);
            vector<int32_t> unresolvedIndices;
            for (auto i : objectIndices) {
                auto field = findUniqueDistinguishingField(ctx, *variants[i], objectVariants);
                if (field)
                    dispatchFields[i] = field;
                else
                    unresolvedIndices.push_back(i);
            }
            // Presence alone couldn't tell 2+ variants apart - try "field-value" dispatch among
            // exactly those before giving up: a property every one of them declares, but each
            // pins to a different literal value (see findFieldValueDispatch).
            if (unresolvedIndices.size() > 1) {
                vector<JSValueConst> unresolvedVariants;
                for (auto i : unresolvedIndices)
                    unresolvedVariants.push_back(*variants[i]);
                if (auto fieldValueDispatch = findFieldValueDispatch(ctx, unresolvedVariants)) {
                    for (size_t k = 0; k < unresolvedIndices.size(); k++) {
                        if (fieldValueDispatch->values[k]) {
                            dispatchFields[unresolvedIndices[k]] = fieldValueDispatch->field;
                            dispatchValues[unresolvedIndices[k]] = fieldValueDispatch->values[k];
                        }
                    }
                    unresolvedIndices.clear();
                }
            }
            if (unresolvedIndices.size() > 1)
                throw runtime_error(
                    format("<9b149efe> Cannot disambiguate object-shaped oneOf/anyOf variants: {} variants have no "
                           "property (required or not) that no other object variant also declares, and no shared "
                           "property pins each of them to a distinct literal value either - at most one object "
                           "variant may be left undistinguished (it becomes the shape-based fallback, tried last)",
                           unresolvedIndices.size()));
        }

        map<string, int32_t> countByKind;
        for (const auto& k : dispatchKinds)
            countByKind[k]++;
        for (const auto& [k, count] : countByKind) {
            if (k != "object" && count > 1) {
                if (k == "any")
                    throw runtime_error(
                        format("<91c40b1e> oneOf/anyOf has {} unconstrained (\"{{}}\") variants - at most one "
                               "catch-all is supported (they'd be indistinguishable from each other)",
                               count));
                throw runtime_error(
                    format("<4afa7df0> Cannot disambiguate multiple \"{}\"-shaped oneOf/anyOf variants (only one "
                           "variant per non-object JSON shape is supported)",
                           k));
            }
        }

        auto variantsArr = JS_NewArray(ctx);
        checkForException(ctx, variantsArr, "<dd3f3193> Cannot create array");
        for (int32_t i = 0; i < len; i++) {
            auto obj = JS_NewObject(ctx);
            checkForException(ctx, obj, "<73a4c169> Cannot create object");
            setObjProperty(ctx, obj, "dispatchKind", JS_NewStringLen(ctx, dispatchKinds[i].data(), dispatchKinds[i].size()));
            setObjProperty(ctx, obj, "dispatchField",
                           dispatchFields[i] ? JS_NewStringLen(ctx, dispatchFields[i]->data(), dispatchFields[i]->size())
                                              : JS_NULL);
            // Only ever set together with dispatchField, and only for "field-value" dispatch (see
            // findFieldValueDispatch) - null for "field-name" dispatch (presence alone was enough)
            // and for the shape-only fallback variant either pass may still leave undistinguished.
            setObjProperty(ctx, obj, "dispatchValue",
                           dispatchValues[i] ? JS_NewStringLen(ctx, dispatchValues[i]->data(), dispatchValues[i]->size())
                                              : JS_NULL);
            JS_DefinePropertyValueUint32(ctx, variantsArr, (uint32_t)i, obj, JS_PROP_C_W_E);
        }

        auto result = JS_NewObject(ctx);
        checkForException(ctx, result, "<9493c4e9> Cannot create object");
        setObjProperty(ctx, result, "variants", variantsArr);
        return result;
    });
}

// Trims a discriminator.mapping ref string ("#/components/schemas/Cat") down to its trailing
// component name ("Cat") - mapping values are never $ref-resolved by the engine (discriminator
// isn't itself a schema - see Discriminator's C++ struct), so they stay literal strings all the
// way to JS.
string trailingRefName(const string& ref)
{
    auto pos = ref.find_last_of('/');
    return pos == string::npos ? ref : ref.substr(pos + 1);
}

// Detects a discriminated oneOf/anyOf (discriminator.propertyName set, every variant a $ref to a
// named schema - the one shape a target language with algebraic/discriminated-union support can
// dispatch on a single literal property) and resolves each variant's component name plus its
// discriminator literal (from discriminator.mapping, falling back to the component name itself
// when a variant has no explicit mapping entry, per the OpenAPI spec's own default). Returns null
// for anything else (no discriminator, or a variant that isn't a named $ref) - left for the caller
// to register as an ordinary, non-dispatchable union instead. Needs `builder` (bound as `data`,
// like nameOf) to check "is this variant a $ref to a named schema" by JS object identity.
JSValue resolveDiscriminatorBuiltin(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv, int magic,
                                    JSValue* data)
{
    return runAndCatchExceptions(ctx, [&] {
        auto& builder = *jsValueToPtr<Generator::OpenApiJsGraphBuilder>(*data);
        if (argc < 1)
            throw runtime_error("<b8c9d0e1> resolveDiscriminator requires 1 argument (schema: object)");
        auto schemaVal = argv[0];

        auto variantsVal = JS_GetPropertyStr(ctx, schemaVal, "oneOf");
        if (!JS_IsArray(ctx, variantsVal)) {
            JS_FreeValue(ctx, variantsVal);
            variantsVal = JS_GetPropertyStr(ctx, schemaVal, "anyOf");
        }
        if (!JS_IsArray(ctx, variantsVal)) {
            JS_FreeValue(ctx, variantsVal);
            return JS_NULL;
        }

        auto discVal = JS_GetPropertyStr(ctx, schemaVal, "discriminator");
        auto propNameVal = JS_IsObject(discVal) ? JS_GetPropertyStr(ctx, discVal, "propertyName") : JS_UNDEFINED;
        if (!JS_IsString(propNameVal)) {
            JS_FreeValue(ctx, propNameVal);
            JS_FreeValue(ctx, discVal);
            JS_FreeValue(ctx, variantsVal);
            return JS_NULL;
        }
        auto propertyName = jsValueToString(ctx, propNameVal);
        JS_FreeValue(ctx, propNameVal);

        map<string, string> nameToLiteral; // component name -> discriminator literal
        auto mappingVal = JS_GetPropertyStr(ctx, discVal, "mapping");
        if (JS_IsObject(mappingVal)) {
            jsIterateObjectProps(ctx, mappingVal, [&](const string& literal, const JSValue& refValue) {
                if (JS_IsString(refValue))
                    nameToLiteral[trailingRefName(jsValueToString(ctx, refValue))] = literal;
            });
        }
        JS_FreeValue(ctx, mappingVal);
        JS_FreeValue(ctx, discVal);

        auto len = jsArrayLength(ctx, variantsVal);
        vector<pair<string, string>> variants; // (component name, discriminator literal)
        variants.reserve(len);
        for (int32_t i = 0; i < len; i++) {
            auto variant = JS_GetPropertyUint32(ctx, variantsVal, (uint32_t)i);
            auto name = builder.nameOf(variant);
            JS_FreeValue(ctx, variant);
            if (!name) {
                JS_FreeValue(ctx, variantsVal);
                return JS_NULL; // not every variant is a $ref to a named schema
            }
            auto it = nameToLiteral.find(*name);
            variants.emplace_back(*name, it != nameToLiteral.end() ? it->second : *name);
        }
        JS_FreeValue(ctx, variantsVal);

        auto variantsArr = JS_NewArray(ctx);
        checkForException(ctx, variantsArr, "<c9d0e1f2> Cannot create array");
        for (size_t i = 0; i < variants.size(); i++) {
            auto obj = JS_NewObject(ctx);
            checkForException(ctx, obj, "<d0e1f2a3> Cannot create object");
            setObjProperty(ctx, obj, "name", JS_NewStringLen(ctx, variants[i].first.data(), variants[i].first.size()));
            setObjProperty(ctx, obj, "literal",
                           JS_NewStringLen(ctx, variants[i].second.data(), variants[i].second.size()));
            JS_DefinePropertyValueUint32(ctx, variantsArr, (uint32_t)i, obj, JS_PROP_C_W_E);
        }

        auto result = JS_NewObject(ctx);
        checkForException(ctx, result, "<e1f2a3b4> Cannot create object");
        setObjProperty(ctx, result, "property", JS_NewStringLen(ctx, propertyName.data(), propertyName.size()));
        setObjProperty(ctx, result, "variants", variantsArr);
        return result;
    });
}

// Copies a static file from the generator's own directory straight into the output directory,
// without routing it through the template engine just to move bytes unchanged (previously the
// only option - see e.g. how kotlin_ktor_server_generator/templates/validation.kt.j2 has no
// `{{ }}` in it at all, just to be `renderTemplate`-able).
JSValue copyFile(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv, int magic, JSValue* data)
{
    return runAndCatchExceptions(ctx, [&] {
        const auto& gen = *jsValueToPtr<const OpenApiGenerator>(*data);

        if (argc != 2)
            throw runtime_error("<5b91ded0> copyFile requires 2 arguments (srcFileName: string, outFileName: string)");
        auto srcFileName = jsValueToString(ctx, argv[0]);
        auto outFileName = jsValueToString(ctx, argv[1]);

        auto content = gen.opts.fileReader->read(srcFileName);
        gen.opts.fileWriter->write(outFileName, content);
        return JS_NewBool(ctx, 1);
    });
}

JSValue renderTemplate(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv, int magic, JSValue* data)
{
    return runAndCatchExceptions(ctx, [&] {
        const auto& gen = *jsValueToPtr<const OpenApiGenerator>(*data);

        if (argc < 3 || argc > 4)
            throw runtime_error("<ff372a54> renderTemplate requires 3 or 4 arguments (templateFileName: string, data: "
                                "object, outFileName: string, funcs?: {<funcName>: function(args)})");
        auto templateFileName = jsValueToString(ctx, argv[0]);
        Node data = jsValueToNode(ctx, argv[1]);
        auto outFileName = jsValueToString(ctx, argv[2]);

        Functions funcs;
        if (argc >= 4)
            funcs = mapJSFuncsToTemplateFuncs(ctx, argv[3]);

        for (const auto& f : getCommonFunctions()) {
            funcs.push_back(f);
        }

        auto content = gen.opts.templateRenderer->render(templateFileName, data, funcs);
        gen.opts.fileWriter->write(outFileName, content);
        return JS_NewBool(ctx, 1);
    });
}

JSValue renderTemplateToString(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv, int magic,
                               JSValue* data)
{
    return runAndCatchExceptions(ctx, [&] {
        const auto& gen = *jsValueToPtr<const OpenApiGenerator>(*data);
        if (argc < 2 || argc > 3)
            throw runtime_error(
                "<d9d81f4b> renderTemplateToString requires 3 or 4 arguments (templateFileName: string, data: "
                "object, funcs?: {<funcName>: function(args)})");
        auto templateFileName = jsValueToString(ctx, argv[0]);
        Node data = jsValueToNode(ctx, argv[1]);
        Functions funcs;
        if (argc >= 3)
            funcs = mapJSFuncsToTemplateFuncs(ctx, argv[2]);
        auto content = gen.opts.templateRenderer->render(templateFileName, data, funcs);
        return JS_NewStringLen(ctx, content.c_str(), content.size());
    });
}

}

OpenApiGenerator::OpenApiGenerator(Opts&& opts)
    : opts(std::move(opts))
{
}

void OpenApiGenerator::generate(const string& specPath)
{
    auto startTime = chrono::high_resolution_clock::now();
    finalize
    {
        auto endTime = chrono::high_resolution_clock::now();
        logger.debug("<eb2395fc> Generation time: {} msec",
                     chrono::duration<double, milli>(endTime - startTime).count());
    };

    if (opts.clearOutDir)
        opts.fileWriter->clear();
    auto metadata = readMetadata(opts.fileReader, opts.metadataPath);
    auto mainScriptPath = metadata.mainScriptPath.value_or(opts.defaultMainSciptPath);

    // Validated before reading/resolving the spec (which can be slow for a large multi-file spec,
    // see external_ref_resolver.h) so a missing/misspelled -v flag fails fast instead of only
    // being reported after all that work is done.
    auto vars = getFinalVars(opts.vars, metadata);

    logger.debug("<5e2e9a47> Reading spec file: {}", specPath);
    auto versioned = convertToGeneratorVersion(metadata, readSpecFile(specPath));
    auto& schemaNode = versioned.node;

    logger.debug("<d2e3f4a5> Parsing OpenAPI document");
    auto doc = OpenApi::V3::Read(NodeWalker(schemaNode), versioned.version);
    logger.debug("<e3f4a5b6> Resolving in-document $refs");
    OpenApi::resolveAllRefs(doc);
    if (!opts.tags.empty()) {
        logger.debug("<a1b2c3d4> Filtering document by tags: {}", opts.tags | joinToString(","));
        OpenApi::filterByTags(doc, schemaNode, opts.tags);
    }
    auto operations = OpenApi::collectOperations(doc);

    auto generatorPtr = this;

    vector<FuncType> commonJsFuncs;
    optional<Generator::OpenApiJsGraphBuilder> builder;
    CollectOperationsCtx collectOperationsCtx { };
    opts.jsExecutor->execute(
        mainScriptPath,
        [&schemaNode, &doc, &operations, generatorPtr, &vars, &commonJsFuncs, &builder,
         &collectOperationsCtx](JSContext* ctx) {
            auto globalObj = JS_GetGlobalObject(ctx);
            finalize { JS_FreeValue(ctx, globalObj); };

            setObjFunction(ctx, globalObj, "copyFile", copyFile, generatorPtr);
            setObjFunction(ctx, globalObj, "renderTemplate", renderTemplate, generatorPtr);
            setObjFunction(ctx, globalObj, "renderTemplateToString", renderTemplateToString, generatorPtr);

            // `schema` is now the fully-resolved document (see OpenApiJsGraphBuilder): every $ref
            // is replaced by the actual (possibly shared/cyclic) target object. This intentionally
            // replaces the old raw-Node `schema` global - existing generators that read `$ref`
            // strings directly will need rewriting onto `nameOf`/`kindOf`/`constraintsOf` instead.
            builder.emplace(ctx);
            setObjProperty(ctx, globalObj, "schema", builder->buildDocumentValue(schemaNode, doc));
            setObjFunction(ctx, globalObj, "kindOf", kindOfBuiltin);
            setObjFunction(ctx, globalObj, "unwrapSchema", unwrapSchemaBuiltin);
            setObjFunction(ctx, globalObj, "constraintsOf", constraintsOfBuiltin);
            setObjFunction(ctx, globalObj, "nameOf", nameOfBuiltin, &*builder);
            collectOperationsCtx = { &*builder, &operations };
            setObjFunction(ctx, globalObj, "collectOperations", collectOperationsBuiltin, &collectOperationsCtx);
            setObjFunction(ctx, globalObj, "firstSuccessResponse", firstSuccessResponseBuiltin);
            setObjFunction(ctx, globalObj, "flattenAllOf", flattenAllOfBuiltin);
            setObjFunction(ctx, globalObj, "resolveDiscriminator", resolveDiscriminatorBuiltin, &*builder);
            setObjFunction(ctx, globalObj, "resolveUnionDispatch", resolveUnionDispatchBuiltin);

            setObjProperty(ctx, globalObj, "vars", nodeToJSValue(ctx, vars));

            auto funcs = getCommonFunctions();
            commonJsFuncs.reserve(funcs.size());
            for (const auto& func : funcs) {
                const auto& jsFunc = commonJsFuncs.emplace_back(func.func);
                setObjFunction(ctx, globalObj, func.name, jsFunc);
            }
        });
}

}
