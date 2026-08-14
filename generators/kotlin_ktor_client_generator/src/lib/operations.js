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
import { ktType } from "./types.js";
import { escapeKotlinStringContent } from "./keywords.js";
import { withResilience } from "./strict.js";

// Kotlin scalar types a path/query/header param can resolve to - the client passes these through
// directly (Kotlin string templates/`queryParam(name, value: Any?)` handle any of them, and an
// enum-typed param converts via its own generated `wireValue`/`fromWireValue`, see
// model_enum.kt.j2), so this is only ever used as a "is this actually a supported scalar shape"
// gate, not to pick a conversion snippet.
const SUPPORTED_SCALAR_PARAM_TYPES = new Set([
  "String",
  "Int",
  "Long",
  "Float",
  "Double",
  "Boolean",
  "kotlinx.datetime.LocalDate",
  "kotlinx.datetime.Instant",
]);

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

// A query parameter whose schema mixes plain scalar variant(s) with exactly one object-shaped
// variant (all-primitive properties) - a common "exact value or range filter" list-endpoint idiom
// (e.g. Stripe's `created: oneOf[integer, {gt, gte, lt, lte}]`, declared with `style: deepObject`).
// Registers the union the ordinary way (ktType/registerUnion - the same sealed-interface +
// wrapper-per-variant shape as any other union), then returns a param descriptor whose
// `queryArms` the template dispatches on at the call site: the scalar arm emits a single
// `queryParam(name, value)`; the object arm emits one `queryParam("name[field]", value)` per
// property (deepObject serialization, e.g. `created[gte]=1700000000`). Returns null (caller falls
// through to the ordinary unsupported-parameter-type error) if the shape doesn't fit - more than
// one object variant, or an object variant with a non-primitive property; those stay unsupported
// rather than guessing at a nested serialization.
function tryBuildFilterUnionQueryParam(registry, hintBase, p, schema) {
  const variants = schema.oneOf || schema.anyOf || [];
  const objectVariants = variants.filter((v) => ["Object", "Map", "AllOf"].includes(kindOf(v)));
  if (objectVariants.length !== 1) return null;
  const [objectVariant] = objectVariants;
  const objectProps = Object.entries(objectVariant.properties || {});
  if (objectProps.length === 0 || objectProps.some(([, propSchema]) => !["Primitive", "Enum"].includes(kindOf(propSchema)))) {
    return null;
  }

  const { kotlinName } = fieldName(p.name);
  const required = !!p.required;
  const t = ktType(registry, schema, hintBase + className(p.name));
  const union = registry.models.get(t.type);
  const queryArms = union.variants.map((v) => {
    if (v.dispatchKind !== "object") return { wrapperName: v.wrapperName, kind: "scalar" };
    const objectModel = registry.models.get(v.valueType);
    return {
      wrapperName: v.wrapperName,
      kind: "object",
      fields: objectModel.properties.map((f) => ({ ktName: f.ktName, wireName: f.wireName })),
    };
  });

  return {
    ktName: kotlinName,
    wireName: p.name,
    in: p.in,
    type: t.type,
    typeLabel: t.type,
    nullable: !required,
    isArray: false,
    queryArms,
    description: p.description || null,
  };
}

// A query param whose (unwrapped) schema is Array-kind - serialized as repeated `?name=a&name=b`
// keys (OpenAPI 3's default `style: form, explode: true`), matching the typescript_fetch_client
// generator's own support for this (path/header positions have no standard "repeated value"
// serialization, so those stay scalar-only).
function buildArrayQueryParam(registry, hintBase, p, itemSchema) {
  const itemT = ktType(registry, itemSchema, hintBase + className(p.name) + "Item");
  const isSupported = kindOf(unwrapSchema(itemSchema)) === "Enum" || SUPPORTED_SCALAR_PARAM_TYPES.has(itemT.type);
  if (!isSupported) {
    throw Error(
      `<01534acc> Unsupported query parameter array item type for "${p.name}": array items must be ` +
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
    queryArms: null,
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
  const isSupported = kindOf(resolved) === "Enum" || SUPPORTED_SCALAR_PARAM_TYPES.has(t.type);
  if (!isSupported) {
    throw Error(
      `<394d7fec> Unsupported parameter type for "${p.name}" (in: ${p.in}): only primitive scalar ` +
        `types (string/integer/number/boolean) or enums are supported in path/query/header position, got "${t.type}"`
    );
  }
  const isPath = p.in === "path";
  const required = isPath || !!p.required;
  const { kotlinName } = fieldName(p.name);
  return {
    ktName: kotlinName,
    wireName: p.name,
    in: p.in,
    type: t.type,
    typeLabel: t.type,
    nullable: !required,
    isArray: false,
    queryArms: null,
    description: p.description || null,
  };
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

// application/x-www-form-urlencoded and multipart/form-data bodies are, by OpenAPI convention,
// always `type: object` schemas with one property per form field. Anything else (a nested
// object/array property) is a generator error - same "handle the common case, error on the rest"
// policy path/header params already follow. A `type: string, format: binary` property is already
// classified `Primitive` by the engine's kindOf() (same as any other string), so it passes this
// check and ends up typed the same generic `String` primitiveKtType maps every `format: binary`
// schema to - unlike the TypeScript generator's multipart binary fields (mapped to `Blob | File`),
// this generator doesn't special-case it to a Kotlin `ByteArray`/streaming type (see README "Known
// limitations" - this is a real, currently-undithered gap, not a design choice).
function requireFlatObjectSchema(bodySchema, mediaType) {
  if (kindOf(bodySchema) !== "Object") {
    throw Error(`<c7e2a915> A "${mediaType}" body must be an object schema (one property per form field) - got ${kindOf(bodySchema)}`);
  }
  for (const [propName, propSchema] of Object.entries(bodySchema.properties || {})) {
    const kind = kindOf(unwrapSchema(propSchema));
    if (kind !== "Primitive" && kind !== "Enum") {
      throw Error(
        `<f31b0d6a> Unsupported "${mediaType}" body field "${propName}": only primitive scalar types ` +
          `(including format: binary strings) or enums are supported as form fields - got ${kind}`
      );
    }
  }
}

// Picks which request-body media type is present, preferring JSON (the common case), then
// multipart, then urlencoded. Failing those, a single remaining media type is still accepted as a
// raw body: "text/*" becomes a plain Kotlin `String`, anything else (application/octet-stream,
// application/zip, image/*, ...) becomes a raw `ByteArray` - the wire content-type, not the
// declared schema, decides which (see buildRequestBody below; both are natively `setBody()`-able by
// Ktor with no extra plugin, same as a JSON body needs ContentNegotiation for). Returns null only
// when `content` has entries but none of the above applies - more than one non-JSON/form media type
// is ambiguous (which one would the generated method actually send?) and the caller turns that into
// a generation error instead of guessing (see this generator's README "Known limitations").
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
      `<8e94c2b7> Unsupported request body content-type(s) [${Object.keys(content).join(", ")}] - only ` +
        `"${JSON_MEDIA_TYPE}", "${MULTIPART_MEDIA_TYPE}", "${URLENCODED_MEDIA_TYPE}", a single "text/*" media ` +
        `type (sent as a String), or a single other media type (sent as raw bytes) are supported`
    );
  }
  const bodySchema = picked.content.schema || {};
  // "text"/"bytes": the wire content-type alone decides the Kotlin type (String/ByteArray)
  // regardless of the declared schema - matches actual HTTP semantics (the Content-Type header is
  // what a real client/server keys its parsing on), and mirrors multipart/urlencoded's own "handle
  // the common case, don't require a specific schema shape" policy above.
  if (picked.encoding === "text") {
    return { type: "String", required: requestBody.required === true, encoding: "text", mediaType: picked.mediaType };
  }
  if (picked.encoding === "bytes") {
    return { type: "ByteArray", required: requestBody.required === true, encoding: "bytes", mediaType: picked.mediaType };
  }
  if (picked.encoding !== "json") requireFlatObjectSchema(bodySchema, picked.mediaType);
  const t = ktType(registry, bodySchema, hintBase + "Body");
  const result = { type: t.type, required: requestBody.required === true, encoding: picked.encoding, mediaType: null };
  // urlencoded/multipart need each field's own name to build one append(...) call per property
  // (see api_client.kt.j2) - Kotlin has no runtime reflection over a data class's properties to
  // lean on instead, unlike the Ruby generator's equivalent (a plain Hash walked generically at
  // request time).
  if (picked.encoding !== "json") result.fields = (registry.models.get(t.type) || {}).properties || [];
  return result;
}

// Uses the engine's firstSuccessResponse() (see docs/javascript-api.md) instead of hand-rolling
// the same "first declared 2xx, else default" pick every response-handling generator otherwise
// needs. `application/json` gets a real generated data class type; a single remaining "text/*"
// media type maps to a plain Kotlin `String`, and a single remaining other media type maps to a raw
// `ByteArray` - both natively readable via Ktor's `response.body<T>()` with no extra plugin, same
// content-type-driven policy as buildRequestBody. More than one remaining media type is still a
// loud error, not a guess (see README "Known limitations").
function buildResponse(registry, hintBase, responses) {
  const picked = firstSuccessResponse(responses || {});
  if (!picked) return { type: "Unit", statusCode: 200 };
  const statusCode = /^\d+$/.test(picked.statusCode) ? parseInt(picked.statusCode, 10) : 200;
  const content = picked.response.content || {};
  if (Object.keys(content).length === 0) return { type: "Unit", statusCode };
  const jsonContent = content[JSON_MEDIA_TYPE];
  if (jsonContent) {
    const t = ktType(registry, jsonContent.schema || {}, hintBase + "Response");
    return { type: t.type, statusCode };
  }
  const remaining = Object.keys(content);
  if (remaining.length === 1) {
    return { type: isTextMediaType(remaining[0]) ? "String" : "ByteArray", statusCode };
  }
  throw Error(
    `<2d5f8a4c> Unsupported response content-type(s) [${remaining.join(", ")}] for the success response - only ` +
      `"${JSON_MEDIA_TYPE}", a single "text/*" media type, or a single other media type (as ByteArray) are ` +
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

// Returns a Map<tag, { tagClass, propertyName, description, operations: [...] }> in
// path-declaration order.
export function collectOperationsByTag(registry) {
  const groups = new Map();
  for (const op of collectOperations()) {
    // Ktor's HttpClient/routing DSL has no trace() builder - keep the same generated surface as
    // before rather than silently starting to emit trace operations now that collectOperations()
    // reports every method the spec declares.
    if (op.method === "trace") continue;

    withResilience(
      `operation ${op.method.toUpperCase()} ${op.path}`,
      () => {
        const tag = (op.tags && op.tags[0]) || "Default";
        const tagClass = className(tag) + "Api";
        const propertyName = fieldName(tag).kotlinName;
        const opName = operationName(op.method, op.path, op.operationId);
        const hintBase = tagClass + className(opName);

        const allParams = op.parameters.map((p) => buildParam(registry, hintBase, p));
        const pathParams = allParams.filter((p) => p.in === "path");
        const queryParams = allParams.filter((p) => p.in === "query");
        const headerParams = allParams.filter((p) => p.in === "header");

        const body = buildRequestBody(registry, hintBase, op.requestBody);
        const response = buildResponse(registry, hintBase, op.responses);
        const { signatureParams, handlerArgs } = buildSignature(allParams, body);

        if (!groups.has(tag)) groups.set(tag, { tagClass, propertyName, description: tagDescription(tag), operations: [] });
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
