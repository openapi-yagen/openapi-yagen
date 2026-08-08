#include "openapi_generator.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstring>
#include <map>
#include <set>
#include <stdexcept>
#include <utility>

#include <nlohmann/json-schema.hpp>
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
#include "../openapi/resolve.h"
#include "../templates/template_renderer.h"
#include "functions.h"
#include "generator_metadata.h"
#include "openapi_js_bridge.h"

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

Node readSpecFile(const string& filePath)
{
    try {
        auto specFile = FS::readFile(filePath);
        return parseYamlOrJsonToNode(specFile);
    } catch (const exception& e) {
        throw runtime_error(format("<2b4ec139> Cannot read spec file \"{}\". Error: {}", filePath, e.what()));
    }
}

nlohmann::json nodeToJson(const Node& n)
{
    return visit(
        [](auto&& v) -> nlohmann::json {
            using T = decay_t<decltype(v)>;
            if constexpr (is_same_v<T, Node::Null>) {
                return nullptr;
            } else if constexpr (is_same_v<T, Node::Vec>) {
                auto arr = nlohmann::json::array();
                for (const auto& e : v)
                    arr.push_back(nodeToJson(e));
                return arr;
            } else if constexpr (is_same_v<T, Node::Map>) {
                auto obj = nlohmann::json::object();
                for (const auto& [key, value] : v)
                    obj[key] = nodeToJson(value);
                return obj;
            } else {
                return v; // Bool, Int, String all convert implicitly to nlohmann::json
            }
        },
        n.value);
}

// nlohmann-json-schema-validator's built-in format checker throws for a handful of
// draft-07 `format` values it recognizes but hasn't implemented (e.g. "uri-reference", used by
// the official OpenAPI schema's `$ref` definition) - treating an unimplemented/unrecognized
// format as a hard failure would reject every spec that uses those, including the schema's own
// $ref-bearing Reference Object. Per the JSON Schema spec, `format` is an annotation unless a
// validator specifically implements assertion for it, so unimplemented/unknown formats are
// treated as a no-op here; formats the library does implement (date-time, uri, email, ...) still
// fail validation on genuinely malformed values.
void checkStringFormat(const string& format, const string& value)
{
    try {
        nlohmann::json_schema::default_string_format_check(format, value);
    } catch (const logic_error&) {
        // Unimplemented or unrecognized format - ignore.
    }
}

// Validates the parsed spec against the generator's declared `jsonSchemaPath` (see
// GeneratorMetadata / the "Json schema for input data validation" field in generator.yml docs).
// A no-op when the generator didn't declare one.
void validateSpecAgainstJsonSchema(const FS::FileReaderPtr& fileReader, const GeneratorMetadata& metadata,
                                   const Node& specNode)
{
    if (!metadata.jsonSchemaPath)
        return;
    const auto& jsonSchemaPath = *metadata.jsonSchemaPath;

    nlohmann::json schemaJson;
    try {
        schemaJson = nlohmann::json::parse(fileReader->read(jsonSchemaPath));
    } catch (const exception& e) {
        throw runtime_error(
            format("<a1b1c1d1> Cannot read/parse JSON schema \"{}\". Error: {}", jsonSchemaPath, e.what()));
    }

    nlohmann::json_schema::json_validator validator(nullptr, checkStringFormat);
    try {
        validator.set_root_schema(schemaJson);
    } catch (const exception& e) {
        throw runtime_error(format("<b2c2d2e2> Invalid JSON schema \"{}\". Error: {}", jsonSchemaPath, e.what()));
    }

    try {
        validator.validate(nodeToJson(specNode));
    } catch (const exception& e) {
        throw runtime_error(
            format("<c3d3e3f3> Spec file does not conform to JSON schema \"{}\". Error: {}", jsonSchemaPath, e.what()));
    }
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
    auto getStr = [&](const char* key) -> optional<string> {
        auto val = JS_GetPropertyStr(ctx, v, key);
        optional<string> res;
        if (JS_IsString(val))
            res = jsValueToString(ctx, val);
        JS_FreeValue(ctx, val);
        return res;
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

    auto type = getStr("type");

    if (getArrLen("enum") > 0)
        return "Enum";
    if (getArrLen("allOf") > 0)
        return "AllOf";
    if (getArrLen("oneOf") > 0)
        return "OneOf";
    if (getArrLen("anyOf") > 0)
        return "AnyOf";
    if (type == "array")
        return "Array";
    if (getObjHasKeys("properties"))
        return "Object";

    auto apVal = JS_GetPropertyStr(ctx, v, "additionalProperties");
    bool hasAdditionalProperties = !JS_IsUndefined(apVal);
    JS_FreeValue(ctx, apVal);
    if (type == "object" || hasAdditionalProperties)
        return "Map";

    if (type == "string" || type == "integer" || type == "number" || type == "boolean")
        return "Primitive";
    return "Unknown";
}

JSValue kindOfBuiltin(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv)
{
    return runAndCatchExceptions(ctx, [&] {
        if (argc < 1)
            throw runtime_error("<b1c2d3e4> kindOf requires 1 argument (schema: object)");
        auto kind = kindOfShallow(ctx, argv[0]);
        return JS_NewStringLen(ctx, kind.data(), kind.size());
    });
}

// Only leaf/scalar constraint fields are read - none of these are ever nested schemas, so no
// cycle-safety concern here at all (unlike kindOf's shape-classifying fields).
JSValue constraintsOfBuiltin(JSContext* ctx, JSValueConst thisVal, int argc, JSValueConst* argv)
{
    return runAndCatchExceptions(ctx, [&] {
        if (argc < 1)
            throw runtime_error("<c2d3e4f5> constraintsOf requires 1 argument (schema: object)");
        auto obj = JS_NewObject(ctx);
        checkForException(ctx, obj, "<d3e4f5a6> Cannot create object");
        for (const char* key :
             { "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "uniqueItems" }) {
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
            throw runtime_error("<a1b2c3d4> firstSuccessResponse requires 1 argument (responses: object)");
        if (!JS_IsObject(argv[0]))
            return JS_NULL;

        JSPropertyEnum* propEnum;
        uint32_t len;
        if (JS_GetOwnPropertyNames(ctx, &propEnum, &len, argv[0], JS_GPN_STRING_MASK) < 0)
            throw runtime_error("<b2c3d4e5> Cannot enumerate responses object");
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
        checkForException(ctx, result, "<c3d4e5f6> Cannot create object");
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
            throw runtime_error("<d4e5f6a7> flattenAllOf requires 1 argument (schema: object)");

        auto propertiesObj = JS_NewObject(ctx);
        checkForException(ctx, propertiesObj, "<e5f6a7b8> Cannot create object");
        vector<string> required;
        set<string> seenRequired;
        flattenAllOfInto(ctx, argv[0], propertiesObj, required, seenRequired);

        auto requiredArr = JS_NewArray(ctx);
        checkForException(ctx, requiredArr, "<f6a7b8c9> Cannot create array");
        for (size_t i = 0; i < required.size(); i++)
            JS_DefinePropertyValueUint32(ctx, requiredArr, (uint32_t)i,
                                         JS_NewStringLen(ctx, required[i].data(), required[i].size()), JS_PROP_C_W_E);

        auto result = JS_NewObject(ctx);
        checkForException(ctx, result, "<a7b8c9d0> Cannot create object");
        setObjProperty(ctx, result, "properties", propertiesObj);
        setObjProperty(ctx, result, "required", requiredArr);
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
            throw runtime_error("<a9b8c7d6> copyFile requires 2 arguments (srcFileName: string, outFileName: string)");
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
    auto schemaNode = readSpecFile(specPath);
    validateSpecAgainstJsonSchema(opts.fileReader, metadata, schemaNode);

    auto doc = OpenApi::parseDocument(NodeWalker(schemaNode));
    OpenApi::resolveAllRefs(doc);
    auto operations = OpenApi::collectOperations(doc);

    auto generatorPtr = this;
    auto vars = getFinalVars(opts.vars, metadata);

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
            setObjFunction(ctx, globalObj, "constraintsOf", constraintsOfBuiltin);
            setObjFunction(ctx, globalObj, "nameOf", nameOfBuiltin, &*builder);
            collectOperationsCtx = { &*builder, &operations };
            setObjFunction(ctx, globalObj, "collectOperations", collectOperationsBuiltin, &collectOperationsCtx);
            setObjFunction(ctx, globalObj, "firstSuccessResponse", firstSuccessResponseBuiltin);
            setObjFunction(ctx, globalObj, "flattenAllOf", flattenAllOfBuiltin);
            setObjFunction(ctx, globalObj, "resolveDiscriminator", resolveDiscriminatorBuiltin, &*builder);

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
