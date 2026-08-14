// Groups the engine's already-merged/deref'd collectOperations() by tag, and builds a fully
// precomputed description of each operation (parameter extraction/validation, request/response
// types, Kotlin function signature) so the .kt.j2 templates stay close to flat printers instead
// of re-deriving logic.
//
// Everything here runs before any renderTemplate call (see main.js), while schema/parameter/
// response objects still have real JS identity - kindOf/constraintsOf/nameOf/firstSuccessResponse
// only work up to that point (see README's "renderTemplate" docs on the Node round-trip that
// erases it afterwards).

import { className, fieldName, operationName } from "./naming.js";
import { ktType, buildValidationCalls } from "./types.js";
import { escapeKotlinString, escapeKotlinStringContent } from "./keywords.js";
import { withResilience } from "./strict.js";

const PARAM_CONVERTERS = {
  String: "it",
  Int: "it.toInt()",
  Long: "it.toLong()",
  Float: "it.toFloat()",
  Double: "it.toDouble()",
  Boolean: "it.toBoolean()",
  // kotlinx.datetime's own parse() throws DateTimeFormatException, itself an
  // IllegalArgumentException (see primitiveKtType in types.js for the format:date/date-time
  // mapping), so it's compatible as-is with convertOrThrow's catch clause (see validation.kt.j2).
  "kotlinx.datetime.LocalDate": "kotlinx.datetime.LocalDate.parse(it)",
  "kotlinx.datetime.Instant": "kotlinx.datetime.Instant.parse(it)",
};

// A oneOf/anyOf in parameter position can't reuse the JSON-shape-dispatching "union" model (see
// registerUnion in types.js) - a path/query/header value is always just a string on the wire,
// with no structural shape (object vs array vs ...) to dispatch on the way a JSON body has. If
// every variant is itself primitive-like (no object/array variant), the wire representation is
// unambiguous either way, so it's simplest and most honest to just pass the raw string straight
// through untyped rather than inventing a Kotlin type for it - the API itself decides how to
// interpret it (e.g. DigitalOcean's ssh_key_identifier: "either the ID or the fingerprint").
function isPrimitiveLikeUnion(schema) {
  const kind = kindOf(schema);
  if (kind !== "OneOf" && kind !== "AnyOf") return false;
  const variants = schema.oneOf || schema.anyOf || [];
  return variants.length > 0 && variants.every((v) => ["Primitive", "Enum"].includes(kindOf(v)));
}

// A query parameter whose schema mixes exactly one plain scalar variant with exactly one
// object-shaped variant (all-primitive properties) - a common "exact value or range filter"
// list-endpoint idiom (e.g. Stripe's `created: oneOf[integer, {gt, gte, lt, lte}]`, declared with
// `style: deepObject`). Registers the union the ordinary way (ktType/registerUnion - same
// sealed-interface + wrapper-per-variant shape as any other union), then returns a param
// descriptor whose `queryFilter` the template uses to PARSE either wire form: the plain key
// (`created=1700000000`) wins if present; otherwise, if any `name[field]` key is present, each
// declared field is parsed individually (matching the client's serialization side - see the
// client generator's own operations.js) into the filter object. Returns null (caller falls
// through to the ordinary unsupported-parameter-type error) if the shape doesn't fit - anything
// other than exactly one scalar/enum variant plus one all-primitive-property object variant.
function tryBuildFilterUnionQueryParam(registry, hintBase, p, schema) {
  const variants = schema.oneOf || schema.anyOf || [];
  const objectVariants = variants.filter((v) => ["Object", "Map", "AllOf"].includes(kindOf(v)));
  const scalarVariants = variants.filter((v) => ["Primitive", "Enum"].includes(kindOf(v)));
  if (objectVariants.length !== 1 || scalarVariants.length !== 1) return null;
  const [objectVariant] = objectVariants;
  const [scalarVariant] = scalarVariants;
  const objectProps = Object.entries(objectVariant.properties || {});
  if (objectProps.length === 0 || objectProps.some(([, propSchema]) => !["Primitive", "Enum"].includes(kindOf(propSchema)))) {
    return null;
  }

  const { kotlinName } = fieldName(p.name);
  const required = !!p.required;
  const t = ktType(registry, schema, hintBase + className(p.name));
  const union = registry.models.get(t.type);
  const scalarArm = union.variants.find((v) => v.dispatchKind !== "object");
  const objectArm = union.variants.find((v) => v.dispatchKind === "object");
  const scalarConverter =
    kindOf(scalarVariant) === "Enum" ? `${scalarArm.valueType}.fromWireValue(it)` : PARAM_CONVERTERS[scalarArm.valueType];
  if (!scalarConverter) return null;

  const objectModel = registry.models.get(objectArm.valueType);
  const fields = [];
  for (const propModel of objectModel.properties) {
    const propSchema = objectVariant.properties[propModel.wireName];
    const converter = kindOf(propSchema) === "Enum" ? `${propModel.type}.fromWireValue(it)` : PARAM_CONVERTERS[propModel.type];
    if (!converter) return null;
    fields.push({ ktName: propModel.ktName, wireName: propModel.wireName, typeLabel: propModel.type, converter });
  }

  return {
    ktName: kotlinName,
    wireName: p.name,
    in: p.in,
    type: t.type,
    typeLabel: t.type,
    nullable: !required,
    isArray: false,
    queryFilter: {
      scalarWrapper: scalarArm.wrapperName,
      scalarTypeLabel: scalarArm.valueType,
      scalarConverter,
      objectWrapper: objectArm.wrapperName,
      objectValueType: objectArm.valueType,
      fields,
    },
    converter: null,
    extractFn: null,
    validationCalls: [],
    description: p.description || null,
  };
}

// A query param whose (unwrapped) schema is Array-kind - serialized as repeated `?name=a&name=b`
// keys (OpenAPI 3's default `style: form, explode: true`), matching the typescript_fetch_client
// generator's own support for this (path/header positions have no standard "repeated value"
// serialization, so those stay scalar-only). `converter`/`typeLabel` describe the ITEM type, not
// the `List<...>` as a whole - queryParamListAs/requireQueryParamListAs (see validation.kt.j2)
// apply it per element.
function buildArrayQueryParam(registry, hintBase, p, itemSchema) {
  const itemT = ktType(registry, itemSchema, hintBase + className(p.name) + "Item");
  const itemConverter =
    kindOf(unwrapSchema(itemSchema)) === "Enum" ? `${itemT.type}.fromWireValue(it)` : PARAM_CONVERTERS[itemT.type];
  if (!itemConverter) {
    throw Error(
      `<ba151d07> Unsupported query parameter array item type for "${p.name}": array items must be ` +
        `primitive scalar types (string/integer/number/boolean) or enums, got "${itemT.type}"`
    );
  }
  const { kotlinName } = fieldName(p.name);
  const required = !!p.required;
  return {
    ktName: kotlinName,
    wireName: p.name,
    in: p.in,
    type: `List<${itemT.type}>`,
    typeLabel: itemT.type,
    nullable: !required,
    isArray: true,
    queryFilter: null,
    converter: itemConverter,
    extractFn: required ? "requireQueryParamListAs" : "queryParamListAs",
    validationCalls: [],
    description: p.description || null,
  };
}

function buildParam(registry, hintBase, p) {
  const schema = p.schema || { type: "string" };
  const resolved = unwrapSchema(schema);
  if (p.in === "query" && kindOf(resolved) === "Array") {
    return buildArrayQueryParam(registry, hintBase, p, resolved.items || { type: "string" });
  }
  if (p.in === "query" && (kindOf(resolved) === "OneOf" || kindOf(resolved) === "AnyOf") && !isPrimitiveLikeUnion(resolved)) {
    const filterParam = tryBuildFilterUnionQueryParam(registry, hintBase, p, resolved);
    if (filterParam) return filterParam;
  }
  const t = isPrimitiveLikeUnion(resolved) ? { type: "String" } : ktType(registry, schema, hintBase + className(p.name));
  // An enum-typed param parses/prints via the enum's own wireValue/fromWireValue (see
  // model_enum.kt.j2) rather than a fixed PARAM_CONVERTERS entry, since the conversion snippet
  // needs the enum's own class name embedded in it.
  const converter = kindOf(resolved) === "Enum" ? `${t.type}.fromWireValue(it)` : PARAM_CONVERTERS[t.type];
  if (!converter) {
    throw Error(
      `<4414ebee> Unsupported parameter type for "${p.name}" (in: ${p.in}): only primitive scalar ` +
        `types (string/integer/number/boolean) or enums are supported in path/query/header position, got "${t.type}"`
    );
  }
  const isPath = p.in === "path";
  const required = isPath || !!p.required;
  const { kotlinName } = fieldName(p.name);
  const constraints = constraintsOf(p.schema || {});
  let extractFn;
  if (isPath) extractFn = "pathParamAs";
  else if (p.in === "header") extractFn = required ? "requireHeaderParamAs" : "headerParamAs";
  else extractFn = required ? "requireQueryParamAs" : "queryParamAs";
  return {
    ktName: kotlinName,
    wireName: p.name,
    in: p.in,
    type: t.type,
    typeLabel: t.type,
    nullable: !required,
    isArray: false,
    queryFilter: null,
    converter,
    extractFn,
    validationCalls: buildValidationCalls(kotlinName, p.name, t.type, constraints),
    description: p.description || null,
  };
}

// Builds one handler parameter for a single named security scheme (one entry of a `security`
// requirement object) - see buildAuthParams below for how the requirement array/object as a whole
// is interpreted. Only http/bearer and apiKey are supported (the two Validation.kt has runtime
// helpers for); oauth2/openIdConnect are a generator error (withResilience: warning + no auth
// param in non-strict mode - see collectOperationsByTag).
function buildAuthParamForScheme(schemeName, scheme) {
  if (!scheme) {
    throw Error(`<590e8da1> security references scheme "${schemeName}", not declared in components.securitySchemes`);
  }
  const { kotlinName } = fieldName(schemeName);
  if (scheme.type === "http" && String(scheme.scheme || "").toLowerCase() === "bearer") {
    return { ktName: kotlinName, type: "String", nullable: false, extractExpr: `call.requireBearerToken("Authorization")` };
  }
  if (scheme.type === "apiKey") {
    const loc = scheme.in;
    if (loc !== "header" && loc !== "query" && loc !== "cookie") {
      throw Error(`<4f7bcbf0> apiKey security scheme "${schemeName}" has an unsupported location "in: ${loc}"`);
    }
    return {
      ktName: kotlinName,
      type: "String",
      nullable: false,
      extractExpr: `call.requireApiKey("${loc}", ${escapeKotlinString(scheme.name)})`,
    };
  }
  throw Error(
    `<13404665> Unsupported security scheme type "${scheme.type}" for "${schemeName}" - only http/bearer and ` +
      `apiKey are currently supported`
  );
}

// Turns an operation's already-resolved `security` (see collectOperations() in
// docs/javascript-api.md) into extra required handler parameters, one per named scheme. `security`
// is an array of alternative requirement objects (OR between array entries, AND between the scheme
// names within one object) - only a single alternative is supported today (the common case: one
// way to authenticate), since generating a runtime OR-branch per alternative is real added
// complexity with no consumer needing it yet.
function buildAuthParams(op) {
  const reqs = op.security || [];
  if (reqs.length === 0) return [];
  if (reqs.length > 1) {
    throw Error(
      `<48aa07d7> Operation has ${reqs.length} alternative security requirements (OR) - only a single ` +
        `requirement is supported`
    );
  }
  const schemeNames = Object.keys(reqs[0]);
  if (schemeNames.length === 0) return []; // an empty requirement object = anonymous access is allowed
  const schemes = (schema.components && schema.components.securitySchemes) || {};
  return schemeNames.map((name) => buildAuthParamForScheme(name, schemes[name]));
}

function paramSig(p) {
  return `${p.ktName}: ${p.type}${p.nullable ? "? = null" : ""}`;
}

function buildSignature(allParams, body) {
  const required = allParams.filter((p) => !p.nullable);
  const optional = allParams.filter((p) => p.nullable);
  const ordered = [...required, ...optional];
  const parts = ordered.map(paramSig);
  const args = ordered.map((p) => p.ktName);
  if (body) {
    parts.push(`body: ${body.type}${body.required ? "" : "? = null"}`);
    args.push("body");
  }
  return { signatureParams: parts.join(", "), handlerArgs: args.join(", ") };
}

// Uses the engine's splitPathTemplate() (see docs/javascript-api.md) instead of hand-rolling the
// same "/"-split + `{param}` regex every path-based generator otherwise needs.
function buildPathExpr(pathStr) {
  return (
    "/" +
    splitPathTemplate(pathStr)
      .map((seg) => ("param" in seg ? "${" + fieldName(seg.param).kotlinName + "}" : escapeKotlinStringContent(seg.literal)))
      .join("/")
  );
}

const JSON_MEDIA_TYPE = "application/json";
const MULTIPART_MEDIA_TYPE = "multipart/form-data";
const URLENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded";

// Any "text/*" media type (text/plain, text/html, text/csv, text/markdown, ...) - a whole,
// language-level-open subtype registry, so this is a prefix check rather than a fixed set.
function isTextMediaType(mediaType) {
  return mediaType.startsWith("text/");
}

// application/x-www-form-urlencoded bodies are, by OpenAPI convention, always `type: object`
// schemas with one property per form field - same restriction path/header params already apply
// via buildParam's own converter lookup below. Anything else (a nested object/array property) is
// a generator error - same "handle the common case, error on the rest" policy this generator
// already follows everywhere else.
function requireFlatObjectSchema(bodySchema, mediaType) {
  if (kindOf(bodySchema) !== "Object") {
    throw Error(`<7b3f9c2e> A "${mediaType}" body must be an object schema (one property per form field) - got ${kindOf(bodySchema)}`);
  }
  for (const [propName, propSchema] of Object.entries(bodySchema.properties || {})) {
    const kind = kindOf(unwrapSchema(propSchema));
    if (kind !== "Primitive" && kind !== "Enum") {
      throw Error(
        `<a06d4e83> Unsupported "${mediaType}" body field "${propName}": only primitive scalar types or ` +
          `enums are supported as form fields - got ${kind}`
      );
    }
  }
}

// Picks which request-body media type is present, preferring JSON (the common case), then
// multipart (received as raw MultiPartData - see buildRequestBody's own comment on why that one
// doesn't go through the model registry), then urlencoded. Failing those, a single remaining media
// type is still accepted as a raw body: "text/*" is received as a plain Kotlin `String`, anything
// else (application/octet-stream, application/zip, image/*, ...) is received as a raw `ByteArray` -
// the wire content-type, not the declared schema, decides which (both are natively `call.receive<T>
// ()`-able with no extra plugin, same as a JSON body needs ContentNegotiation for). Returns null
// only when `content` has entries but none of the above applies - more than one non-JSON/form media
// type is ambiguous (which one would the generated handler actually expect?) and the caller turns
// that into a generation error instead of guessing (see this generator's README "Known
// limitations").
function pickBodyContent(content) {
  if (content[JSON_MEDIA_TYPE]) return { mediaType: JSON_MEDIA_TYPE, content: content[JSON_MEDIA_TYPE], encoding: "json" };
  if (content[MULTIPART_MEDIA_TYPE]) return { mediaType: MULTIPART_MEDIA_TYPE, content: content[MULTIPART_MEDIA_TYPE], encoding: "multipart" };
  if (content[URLENCODED_MEDIA_TYPE]) return { mediaType: URLENCODED_MEDIA_TYPE, content: content[URLENCODED_MEDIA_TYPE], encoding: "urlencoded" };
  const remaining = Object.keys(content);
  if (remaining.length === 1) {
    const mediaType = remaining[0];
    return { mediaType, content: content[mediaType], encoding: isTextMediaType(mediaType) ? "text" : "bytes" };
  }
  return null;
}

// Builds one urlencoded body field's parse descriptor - same PARAM_CONVERTERS/fromWireValue
// lookup buildParam uses for query/header/path params, since a form field arrives exactly the
// same way: an untyped raw string that needs converting/validating, not an already-typed value
// (contrast the client generators' equivalent, which only ever *serializes* an already-typed
// value - never parses one).
function buildFormField(propModel, propSchema) {
  const converter = kindOf(propSchema) === "Enum" ? `${propModel.type}.fromWireValue(it)` : PARAM_CONVERTERS[propModel.type];
  if (!converter) {
    throw Error(
      `<5c8e1f47> Unsupported "${URLENCODED_MEDIA_TYPE}" body field "${propModel.wireName}": no known conversion ` +
        `from a raw form value to ${propModel.type}`
    );
  }
  return { ktName: propModel.ktName, wireName: propModel.wireName, typeLabel: propModel.type, nullable: propModel.nullable, converter };
}

// `required` correctly defaults to OpenAPI 3.0's actual default (`false` when absent) - the
// engine's requestBody.required has no "true unless explicitly false" special case. A requestBody
// with `content: {}` (no media types at all) is treated as bodyless, same as no requestBody at
// all; anything present-but-unhandled is a loud error (see pickBodyContent).
function buildRequestBody(registry, hintBase, requestBody) {
  if (!requestBody) return null;
  const content = requestBody.content || {};
  if (Object.keys(content).length === 0) return null;
  const picked = pickBodyContent(content);
  if (!picked) {
    throw Error(
      `<d29b6f18> Unsupported request body content-type(s) [${Object.keys(content).join(", ")}] - only ` +
        `"${JSON_MEDIA_TYPE}", "${MULTIPART_MEDIA_TYPE}", "${URLENCODED_MEDIA_TYPE}", a single "text/*" media ` +
        `type (received as a String), or a single other media type (received as raw bytes) are supported`
    );
  }

  if (picked.encoding === "multipart") {
    // Doesn't go through ktType/registerObject at all: streaming parts/files don't fit a plain
    // data class shape the way a flat urlencoded field list does, so the handler receives Ktor's
    // own MultiPartData directly instead of a schema-derived type - the one place this generator's
    // usual "handler always sees a clean, typed, already-validated body" promise doesn't hold (see
    // README). Fully-qualified so no import bookkeeping is needed in api_handler.kt.j2, same
    // convention as kotlinx.datetime.Instant/JsonElement elsewhere in this generator.
    return { type: "io.ktor.http.content.MultiPartData", required: true, encoding: "multipart", hasValidate: false };
  }

  // "text"/"bytes": the wire content-type alone decides the Kotlin type (String/ByteArray)
  // regardless of the declared schema - matches actual HTTP semantics (the Content-Type header is
  // what a real client/server keys its parsing on). Both fall through to api_routes.kt.j2's generic
  // `call.receive<T>()` branch (same as JSON) - Ktor's server receive pipeline handles String/
  // ByteArray natively, no ContentNegotiation plugin needed; `hasValidate: false` since String/
  // ByteArray have no generated `.validate()` extension (only model data classes do).
  if (picked.encoding === "text") {
    return { type: "String", required: requestBody.required === true, encoding: "text", hasValidate: false, mediaType: picked.mediaType };
  }
  if (picked.encoding === "bytes") {
    return { type: "ByteArray", required: requestBody.required === true, encoding: "bytes", hasValidate: false, mediaType: picked.mediaType };
  }

  const bodySchema = picked.content.schema || {};
  if (picked.encoding === "urlencoded") requireFlatObjectSchema(bodySchema, picked.mediaType);
  const t = ktType(registry, bodySchema, hintBase + "Body");
  const model = registry.models.get(t.type);
  const result = {
    type: t.type,
    required: requestBody.required === true,
    encoding: picked.encoding,
    hasValidate: !!model && model.kind === "object",
  };
  if (picked.encoding === "urlencoded") {
    result.fields = (model.properties || []).map((propModel) => buildFormField(propModel, bodySchema.properties[propModel.wireName]));
  }
  return result;
}

// Uses the engine's firstSuccessResponse() (see docs/javascript-api.md) instead of hand-rolling
// the same "first declared 2xx, else default" pick every response-handling generator otherwise
// needs. `application/json` gets a real generated data class type, sent via the generic
// `call.respond(status, result)`; a single remaining "text/*" media type maps to a plain Kotlin
// `String` (sent via `call.respondText`), and a single remaining other media type maps to a raw
// `ByteArray` (sent via `call.respondBytes`) - both set the exact declared media type as the
// response's Content-Type (see api_routes.kt.j2), same content-type-driven policy as
// buildRequestBody. More than one remaining media type is still a loud error, not a guess (see
// README "Known limitations").
function buildResponse(registry, hintBase, responses) {
  const picked = firstSuccessResponse(responses || {});
  if (!picked) return { type: "Unit", statusCode: 200, encoding: "json", mediaType: null };
  const statusCode = /^\d+$/.test(picked.statusCode) ? parseInt(picked.statusCode, 10) : 200;
  const content = picked.response.content || {};
  if (Object.keys(content).length === 0) return { type: "Unit", statusCode, encoding: "json", mediaType: null };
  const jsonContent = content[JSON_MEDIA_TYPE];
  if (jsonContent) {
    const t = ktType(registry, jsonContent.schema || {}, hintBase + "Response");
    return { type: t.type, statusCode, encoding: "json", mediaType: null };
  }
  const remaining = Object.keys(content);
  if (remaining.length === 1) {
    const mediaType = remaining[0];
    const encoding = isTextMediaType(mediaType) ? "text" : "bytes";
    return { type: encoding === "text" ? "String" : "ByteArray", statusCode, encoding, mediaType };
  }
  throw Error(
    `<e19a4b6d> Unsupported response content-type(s) [${remaining.join(", ")}] for the success response - only ` +
      `"${JSON_MEDIA_TYPE}", a single "text/*" media type, or a single other media type (as raw bytes) are ` +
      `supported`
  );
}

// Looks up a tag's own document-level description (schema.tags: [{name, description}] - distinct
// from op.tags, which just lists tag NAMES on an operation) for the generated API class's own
// KDoc. null if the tag isn't declared at the document level, or has no description there (a
// spec's top-level tags: list is optional).
function tagDescription(tagName) {
  const tag = (schema.tags || []).find((t) => t.name === tagName);
  return (tag && tag.description) || null;
}

// Returns a Map<tag, { tagClass, description, operations: [...] }> in path-declaration order.
export function collectOperationsByTag(registry) {
  const groups = new Map();
  for (const op of collectOperations()) {
    // Ktor's server routing DSL has no Route.trace() builder - keep the same generated surface as
    // before rather than silently starting to emit trace operations now that collectOperations()
    // reports every method the spec declares.
    if (op.method === "trace") continue;

    withResilience(
      `operation ${op.method.toUpperCase()} ${op.path}`,
      () => {
        const tag = (op.tags && op.tags[0]) || "Default";
        const tagClass = className(tag) + "Api";
        const opName = operationName(op.method, op.path, op.operationId);
        const hintBase = tagClass + className(opName);

        const allParams = op.parameters.map((p) => buildParam(registry, hintBase, p));
        const pathParams = allParams.filter((p) => p.in === "path");
        const queryParams = allParams.filter((p) => p.in === "query");
        const headerParams = allParams.filter((p) => p.in === "header");

        // An unsupported security scheme (oauth2/openIdConnect) or multiple OR alternatives only
        // drops the auth wiring for this one operation (non-strict mode) - not the whole
        // operation, unlike the outer withResilience this block runs inside of.
        let authParams = [];
        withResilience(
          `security for operation ${op.method.toUpperCase()} ${op.path}`,
          () => {
            authParams = buildAuthParams(op);
          },
          () => {
            authParams = [];
          }
        );

        const body = buildRequestBody(registry, hintBase, op.requestBody);
        const response = buildResponse(registry, hintBase, op.responses);
        const { signatureParams, handlerArgs } = buildSignature([...allParams, ...authParams], body);

        if (!groups.has(tag)) groups.set(tag, { tagClass, description: tagDescription(tag), operations: [] });
        groups.get(tag).operations.push({
          name: opName,
          method: op.method,
          pathStr: op.path,
          pathExpr: buildPathExpr(op.path),
          docComment: buildDocComment(
            op.summary,
            op.description,
            allParams.filter((p) => p.description).map((p) => ({ name: p.ktName, description: p.description }))
          ),
          pathParams,
          queryParams,
          headerParams,
          authParams,
          body,
          response,
          returnsValue: response.type !== "Unit",
          signatureParams,
          handlerArgs,
        });
      },
      () => {} // permissive mode: drop this operation, keep the rest of the group as-is
    );
  }
  return groups;
}
