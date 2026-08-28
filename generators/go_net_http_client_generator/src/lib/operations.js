// Groups the engine's already-merged/deref'd collectOperations() by tag, and builds a fully
// precomputed description of each operation (parameter extraction, request/response types, Go
// function signature) so the .go.j2 templates stay close to flat printers instead of re-deriving
// logic.
//
// Everything here runs before any renderTemplate call (see main.js), while schema/parameter/
// response objects still have real JS identity - kindOf/constraintsOf/nameOf/firstSuccessResponse
// only work up to that point.

import { typeName, fieldName, paramName, operationName } from "./naming.js";
import { goType } from "./types.js";
import { toGoStringLiteral } from "./keywords.js";
import { withResilience } from "./strict.js";

// Go scalar types a path/query/header param can resolve to - the client passes these through
// directly (formatParam/pathParam in client/runtime.go handle any of them), so this is only ever
// used as a "is this actually a supported scalar shape" gate, not to pick a conversion snippet.
const SUPPORTED_SCALAR_PARAM_TYPES = new Set(["string", "int", "int32", "int64", "float32", "float64", "bool", "time.Time"]);

// A oneOf/anyOf in parameter position can't reuse the JSON-shape-dispatching union model - a
// path/query/header value is always just a string on the wire, with no structural shape to
// dispatch on the way a JSON body has. If every variant is itself primitive-like (no object/array
// variant), the wire representation is unambiguous either way, so it's simplest and most honest to
// just pass the raw string straight through untyped rather than inventing a Go type for it.
function isPrimitiveLikeUnion(schema) {
  const kind = kindOf(schema);
  if (kind !== "OneOf" && kind !== "AnyOf") return false;
  const variants = schema.oneOf || schema.anyOf || [];
  return variants.length > 0 && variants.every((v) => ["Primitive", "Enum"].includes(kindOf(v)));
}

function isEnumType(registry, typeStr) {
  const m = registry.models.get(typeStr);
  return !!m && m.kind === "enum";
}

// A query param whose (unwrapped) schema is Array-kind - serialized as repeated `?name=a&name=b`
// keys (OpenAPI 3's default `style: form, explode: true`) - path/header positions have no
// standard "repeated value" serialization, so those stay scalar-only.
function buildArrayQueryParam(registry, hintBase, p, itemSchema) {
  const itemT = goType(registry, itemSchema, hintBase + typeName(p.name) + "Item");
  const isSupported = isEnumType(registry, itemT.type) || SUPPORTED_SCALAR_PARAM_TYPES.has(itemT.type);
  if (!isSupported) {
    throw Error(
      `<01534acc> Unsupported query parameter array item type for "${p.name}": array items must be ` +
        `primitive scalar types (string/integer/number/boolean/date-time) or enums, got "${itemT.type}"`
    );
  }
  return {
    goName: paramName(p.name),
    wireName: p.name,
    wireNameLiteral: toGoStringLiteral(p.name),
    in: p.in,
    type: `[]${qualifyModelType(itemT.type)}`,
    itemType: qualifyModelType(itemT.type),
    isArray: true,
    required: !!p.required,
    // A nil slice ranges zero times, so an absent optional array param needs no separate nil
    // check the way an optional scalar (*T) does - never wrapped in an extra pointer.
    pointer: false,
    description: p.description || null,
  };
}

function buildParam(registry, hintBase, p) {
  const schema = p.schema || { type: "string" };
  const resolved = unwrapSchema(schema);
  if (p.in === "query" && kindOf(resolved) === "Array") {
    return buildArrayQueryParam(registry, hintBase, p, resolved.items || { type: "string" });
  }
  const t = isPrimitiveLikeUnion(resolved) ? { type: "string" } : goType(registry, schema, hintBase + typeName(p.name));
  const isSupported = isEnumType(registry, t.type) || SUPPORTED_SCALAR_PARAM_TYPES.has(t.type);
  if (!isSupported) {
    throw Error(
      `<394d7fec> Unsupported parameter type for "${p.name}" (in: ${p.in}): only primitive scalar ` +
        `types (string/integer/number/boolean/date-time) or enums are supported in path/query/header position, got "${t.type}"`
    );
  }
  const isPath = p.in === "path";
  const required = isPath || !!p.required;
  return {
    goName: paramName(p.name),
    wireName: p.name,
    wireNameLiteral: toGoStringLiteral(p.name),
    in: p.in,
    type: qualifyModelType(t.type),
    itemType: null,
    isArray: false,
    required,
    pointer: !required,
    description: p.description || null,
  };
}

function paramSig(p) {
  return `${p.goName} ${p.pointer ? "*" : ""}${p.type}`;
}

function buildSignature(allParams, body) {
  const parts = ["ctx context.Context", ...allParams.map(paramSig)];
  if (body) parts.push(`body ${body.pointer ? "*" : ""}${body.type}`);
  return parts.join(", ");
}

// Uses the engine's splitPathTemplate() instead of hand-rolling the same "/"-split + `{param}`
// regex every path-based generator otherwise needs. Builds a Go fmt.Sprintf format string (with
// "%%" escaping any literal "%" in a path segment) plus one pathParam(...) argument expression per
// path parameter.
function buildPathExpr(pathStr) {
  let format = "";
  const args = [];
  for (const seg of splitPathTemplate(pathStr)) {
    if ("param" in seg) {
      format += "/%s";
      args.push(`pathParam(${paramName(seg.param)})`);
    } else {
      format += "/" + seg.literal.replace(/%/g, "%%");
    }
  }
  return { formatLiteral: toGoStringLiteral(format), args };
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
// policy path/header params already follow.
// A field is also allowed to be an Array of primitive/enum items - sent as a repeated form key
// (`tags=a&tags=b`), the same `style: form, explode: true` convention array-typed query parameters
// already use. An object-shaped or array-of-array/object field is still unsupported: multipart/
// urlencoded have no standard convention for either (unlike a repeated scalar key, which HTML
// forms have used for arrays forever), so inventing one here would be an arbitrary
// generator-specific encoding real API servers wouldn't know to expect.
function requireFlatObjectSchema(registry, bodySchema, mediaType) {
  if (kindOf(bodySchema) !== "Object") {
    throw Error(`<c7e2a915> A "${mediaType}" body must be an object schema (one property per form field) - got ${kindOf(bodySchema)}`);
  }
  for (const [propName, propSchema] of Object.entries(bodySchema.properties || {})) {
    const resolved = unwrapSchema(propSchema);
    const kind = kindOf(resolved);
    if (kind === "Primitive" || kind === "Enum") continue;
    if (kind === "Array") {
      const itemKind = kindOf(unwrapSchema(resolved.items || {}));
      if (itemKind === "Primitive" || itemKind === "Enum") continue;
    }
    throw Error(
      `<f31b0d6a> Unsupported "${mediaType}" body field "${propName}": only primitive scalar types ` +
        `(including format: binary strings, for file upload in a multipart body), enums, or arrays of ` +
        `either (sent as a repeated form key) are supported as form fields - got ${kind}`
    );
  }
}

// Picks which request-body media type is present, preferring JSON (the common case), then
// multipart, then urlencoded. Failing those, a single remaining media type is still accepted as a
// raw body: "text/*" becomes a plain Go string, anything else (application/octet-stream,
// application/zip, image/*, ...) becomes a raw []byte - the wire content-type, not the declared
// schema, decides which. Returns null only when `content` has entries but none of the above
// applies - more than one non-JSON/form media type is ambiguous and the caller turns that into a
// generation error instead of guessing.
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

function buildRequestBody(registry, hintBase, requestBody) {
  if (!requestBody) return null;
  const content = requestBody.content || {};
  if (Object.keys(content).length === 0) return null;
  const picked = pickBodyContent(content);
  if (!picked) {
    throw Error(
      `<8e94c2b7> Unsupported request body content-type(s) [${Object.keys(content).join(", ")}] - only ` +
        `"${JSON_MEDIA_TYPE}", "${MULTIPART_MEDIA_TYPE}", "${URLENCODED_MEDIA_TYPE}", a single "text/*" media ` +
        `type (sent as a string), or a single other media type (sent as raw bytes) are supported`
    );
  }
  const bodySchema = picked.content.schema || {};
  const required = requestBody.required === true;
  if (picked.encoding === "text") {
    return { type: "string", required, pointer: !required, encoding: "text", mediaType: picked.mediaType, mediaTypeLiteral: toGoStringLiteral(picked.mediaType), fields: null };
  }
  if (picked.encoding === "bytes") {
    return { type: "[]byte", required, pointer: !required, encoding: "bytes", mediaType: picked.mediaType, mediaTypeLiteral: toGoStringLiteral(picked.mediaType), fields: null };
  }
  if (picked.encoding !== "json") requireFlatObjectSchema(registry, bodySchema, picked.mediaType);
  const t = goType(registry, bodySchema, hintBase + "Body");
  const fields = picked.encoding !== "json" ? (registry.models.get(t.type) || {}).properties || [] : null;
  // Same "mutate the shared property object before finalizeModels sees it" reasoning as
  // pointer/omitempty decisions elsewhere - a multipart `format: binary` field is an actual file
  // part to write (via multipart.Writer.CreateFormFile), not a text field, so its Go type becomes
  // []byte here. urlencoded has no file-part concept, so a urlencoded `format: binary` field is
  // left as a plain string field, unchanged.
  if (fields) {
    for (const f of fields) {
      f.isFile = picked.encoding === "multipart" && f.format === "binary";
      if (f.isFile) {
        f.type = "[]byte";
        f.isArray = false;
        f.itemType = null;
      } else if (f.type.startsWith("[]")) {
        f.isArray = true;
        f.itemType = f.type.slice(2);
      } else {
        f.isArray = false;
        f.itemType = null;
      }
    }
  }
  return { type: qualifyModelType(t.type), required, pointer: !required, encoding: picked.encoding, mediaType: null, mediaTypeLiteral: null, fields };
}

// Uses the engine's firstSuccessResponse() instead of hand-rolling the same "first declared 2xx,
// else default" pick every response-handling generator otherwise needs. `application/json` gets a
// real generated model type; a single remaining "text/*" media type maps to a plain Go string, and
// a single remaining other media type maps to a raw []byte.
function buildResponse(registry, hintBase, responses) {
  const picked = firstSuccessResponse(responses || {});
  if (!picked) return { type: null, statusCode: 200 };
  const statusCode = /^\d+$/.test(picked.statusCode) ? parseInt(picked.statusCode, 10) : 200;
  const content = picked.response.content || {};
  if (Object.keys(content).length === 0) return { type: null, statusCode };
  const jsonContent = content[JSON_MEDIA_TYPE];
  if (jsonContent) {
    const t = goType(registry, jsonContent.schema || {}, hintBase + "Response");
    return { type: qualifyModelType(t.type), statusCode };
  }
  const remaining = Object.keys(content);
  if (remaining.length === 1) {
    return { type: isTextMediaType(remaining[0]) ? "string" : "[]byte", statusCode };
  }
  throw Error(
    `<2d5f8a4c> Unsupported response content-type(s) [${remaining.join(", ")}] for the success response - only ` +
      `"${JSON_MEDIA_TYPE}", a single "text/*" media type, or a single other media type (as []byte) are supported`
  );
}

// Looks up a tag's own document-level description (schema.tags: [{name, description}] - distinct
// from op.tags, which just lists tag NAMES on an operation).
function tagDescription(tagName) {
  const tag = (schema.tags || []).find((t) => t.name === tagName);
  return (tag && tag.description) || null;
}

const BUILTIN_TYPES = new Set(["string", "int", "int32", "int64", "float32", "float64", "bool", "time.Time", "[]byte", "any"]);

function baseGoType(t) {
  while (true) {
    if (t.startsWith("[]")) {
      t = t.slice(2);
      continue;
    }
    if (t.startsWith("map[string]")) {
      t = t.slice("map[string]".length);
      continue;
    }
    return t;
  }
}

function isModelType(t) {
  return !!t && !BUILTIN_TYPES.has(baseGoType(t));
}

// Prefixes a model-registry type name with "models." wherever it's printed in the client/server
// package (types.js's own goType() returns bare names, correct only for use inside the models
// package itself) - preserves any []/map[string] wrapping. Safe to call on an already-qualified
// or builtin type (idempotent / no-op respectively).
function qualifyModelType(t) {
  if (!t) return t;
  if (t.startsWith("[]")) return "[]" + qualifyModelType(t.slice(2));
  if (t.startsWith("map[string]")) return "map[string]" + qualifyModelType(t.slice("map[string]".length));
  if (t.startsWith("models.")) return t;
  return isModelType(t) ? "models." + t : t;
}

// Precomputes which of a tag's operations need which Go stdlib packages / the models package
// imported - Go fails to compile on an unused import, so client_tag.go.j2/server_routes.go.j2
// can't just import everything unconditionally.
export function computeImportFlags(operations) {
  const flags = { json: false, bytesPkg: false, strings: false, multipart: false, models: false, time: false, urlPkg: false };
  const noteType = (t) => {
    if (isModelType(t)) flags.models = true;
    if (baseGoType(t) === "time.Time") flags.time = true;
  };
  for (const op of operations) {
    if (op.response.type) noteType(op.response.type);
    if (op.response.type && op.response.type !== "string" && op.response.type !== "[]byte") flags.json = true;
    if (op.queryParams.length > 0) flags.urlPkg = true;
    for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...op.cookieParams]) noteType(p.itemType || p.type);
    if (op.body) {
      noteType(op.body.type);
      if (op.body.encoding === "json") {
        flags.json = true;
        flags.bytesPkg = true;
      } else if (op.body.encoding === "urlencoded") {
        flags.strings = true;
        flags.urlPkg = true;
      } else if (op.body.encoding === "multipart") {
        flags.multipart = true;
        flags.bytesPkg = true;
      } else if (op.body.encoding === "text") {
        flags.strings = true;
      } else if (op.body.encoding === "bytes") {
        flags.bytesPkg = true;
      }
      for (const f of op.body.fields || []) noteType(f.type);
    }
  }
  return flags;
}

// Disambiguates a tag's method name against every other method name already generated for that
// same tag - real-world specs sometimes reuse one operationId across multiple methods on the same
// path (e.g. a single "WidgetEntities" operationId for both GET and POST), which would otherwise
// generate two methods with the exact same name on the same Go type.
function disambiguateOperationName(base, method, usedNames) {
  if (!usedNames.has(base)) return base;
  const withMethod = base + toPascalCase(method);
  if (!usedNames.has(withMethod)) return withMethod;
  let n = 2;
  while (usedNames.has(withMethod + n)) n++;
  return withMethod + n;
}

// Returns a Map<tag, { tagType, description, operations: [...], imports: {...} }> in
// path-declaration order.
export function collectOperationsByTag(registry) {
  const groups = new Map();
  const usedNamesByTag = new Map();
  for (const op of collectOperations()) {
    withResilience(
      `operation ${op.method.toUpperCase()} ${op.path}`,
      () => {
        const tag = (op.tags && op.tags[0]) || "Default";
        const tagType = typeName(tag) + "Client";
        if (!usedNamesByTag.has(tag)) usedNamesByTag.set(tag, new Set());
        const usedNames = usedNamesByTag.get(tag);
        const opName = disambiguateOperationName(operationName(op.method, op.path, op.operationId), op.method, usedNames);
        usedNames.add(opName);
        const hintBase = tagType + opName;

        const allParams = op.parameters.map((p) => buildParam(registry, hintBase, p));
        const pathParams = allParams.filter((p) => p.in === "path");
        const queryParams = allParams.filter((p) => p.in === "query");
        const headerParams = allParams.filter((p) => p.in === "header");
        const cookieParams = allParams.filter((p) => p.in === "cookie");

        const body = buildRequestBody(registry, hintBase, op.requestBody);
        const response = buildResponse(registry, hintBase, op.responses);
        const signature = buildSignature(allParams, body);

        if (!groups.has(tag)) groups.set(tag, { tagType, description: tagDescription(tag), operations: [] });
        groups.get(tag).operations.push({
          name: opName,
          method: op.method.toUpperCase(),
          path: buildPathExpr(op.path),
          docComment: buildDocComment(
            op.summary,
            op.description,
            allParams.filter((p) => p.description).map((p) => ({ name: p.goName, description: p.description })),
            "//"
          ),
          pathParams,
          queryParams,
          headerParams,
          cookieParams,
          body,
          response,
          returnsValue: response.type !== null,
          signature,
        });
      },
      () => {} // permissive mode: drop this operation, keep the rest of the group as-is
    );
  }
  for (const group of groups.values()) {
    group.imports = computeImportFlags(group.operations);
  }
  return groups;
}
