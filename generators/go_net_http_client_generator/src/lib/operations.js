// Groups the engine's already-merged/deref'd collectOperations() by tag, and builds a fully
// precomputed description of each operation (parameter extraction, request/response types, Go
// function signature) so the .go.j2 templates stay close to flat printers instead of re-deriving
// logic.
//
// Everything here runs before any renderTemplate call (see main.js), while schema/parameter/
// response objects still have real JS identity - kindOf/constraintsOf/nameOf/firstSuccessResponse
// only work up to that point.

import { typeName, fieldName, paramName, operationName } from "./naming.js";
import { goType, openEnumValues } from "./types.js";
import { underlyingType } from "./validation.js";
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

// OpenAPI's three query-array serialization styles: "form" (default, explode defaults true) sends
// a repeated key (`?tag=a&tag=b`) when exploded, else comma-joined; "spaceDelimited"/"pipeDelimited"
// (explode defaults false) join with a space/pipe instead. arraySeparator is null for the
// repeated-key case (addQueryParamList in client_tag.go.j2, unchanged) or the join character
// otherwise, in which case the template calls addQueryParamJoined instead (see runtime.go).
const ARRAY_QUERY_SEPARATORS = { form: ",", spaceDelimited: " ", pipeDelimited: "|" };

// A named scalar schema (e.g. `type TenantID string`) used by a parameter is passed as the scalar
// it's defined over - parameters have no use for the named type's own methods (it has none).
function resolveScalarAlias(registry, type) {
  const model = registry.models.get(type);
  return model && model.kind === "alias" ? underlyingType(registry, model.targetType) : type;
}

// A query param whose (unwrapped) schema is Array-kind - serialized as repeated `?name=a&name=b`
// keys (OpenAPI 3's default `style: form, explode: true`) - path/header positions have no
// standard "repeated value" serialization, so those stay scalar-only.
function buildArrayQueryParam(registry, hintBase, p, itemSchema) {
  const itemType = resolveScalarAlias(registry, goType(registry, itemSchema, hintBase + typeName(p.name) + "Item").type);
  const isSupported = isEnumType(registry, itemType) || SUPPORTED_SCALAR_PARAM_TYPES.has(itemType);
  if (!isSupported) {
    throw Error(
      `<01534acc> Unsupported query parameter array item type for "${p.name}": array items must be ` +
        `primitive scalar types (string/integer/number/boolean/date-time) or enums, got "${itemType}"`
    );
  }
  const style = p.style || "form";
  const explode = p.explode !== undefined ? p.explode : style === "form";
  let arraySeparator = null;
  if (!explode) {
    const sep = ARRAY_QUERY_SEPARATORS[style];
    if (!sep) {
      throw Error(
        `<044d10b3> Unsupported query parameter array serialization style "${style}" for "${p.name}" - ` +
          `only style: form (explode: true or false), spaceDelimited, or pipeDelimited are supported`
      );
    }
    arraySeparator = sep;
  }
  return {
    goName: paramName(p.name),
    wireName: p.name,
    wireNameLiteral: toGoStringLiteral(p.name),
    in: p.in,
    type: `[]${qualifyModelType(itemType)}`,
    itemType: qualifyModelType(itemType),
    isArray: true,
    required: !!p.required,
    // A nil slice ranges zero times, so an absent optional array param needs no separate nil
    // check the way an optional scalar (*T) does - never wrapped in an extra pointer.
    pointer: false,
    description: p.description || null,
    arraySeparator,
    arraySeparatorLiteral: arraySeparator ? toGoStringLiteral(arraySeparator) : null,
  };
}

function buildParam(registry, hintBase, p) {
  const schema = p.schema || { type: "string" };
  const resolved = unwrapSchema(schema);
  if (p.in === "query" && kindOf(resolved) === "Array") {
    return buildArrayQueryParam(registry, hintBase, p, resolved.items || { type: "string" });
  }
  const isPlainString = isPrimitiveLikeUnion(resolved) && !openEnumValues(resolved);
  const type = isPlainString ? "string" : resolveScalarAlias(registry, goType(registry, schema, hintBase + typeName(p.name)).type);
  const isSupported = isEnumType(registry, type) || SUPPORTED_SCALAR_PARAM_TYPES.has(type);
  if (!isSupported) {
    throw Error(
      `<394d7fec> Unsupported parameter type for "${p.name}" (in: ${p.in}): only primitive scalar ` +
        `types (string/integer/number/boolean/date-time) or enums are supported in path/query/header position, got "${type}"`
    );
  }
  const isPath = p.in === "path";
  const required = isPath || !!p.required;
  return {
    goName: paramName(p.name),
    wireName: p.name,
    wireNameLiteral: toGoStringLiteral(p.name),
    in: p.in,
    type: qualifyModelType(type),
    itemType: null,
    isArray: false,
    required,
    pointer: !required,
    description: p.description || null,
  };
}

// One securityScheme as a client/runtime.go securityRequirement literal, or null if the client
// can't supply its credentials.
function securityRequirementLiteral(schemeName, scheme) {
  const fields = [`scheme: ${toGoStringLiteral(schemeName)}`];
  const isBearerLike =
    (scheme.type === "http" && (scheme.scheme || "").toLowerCase() === "bearer") || scheme.type === "oauth2" || scheme.type === "openIdConnect";
  if (isBearerLike) fields.push("bearer: true");
  else if (scheme.type === "apiKey") fields.push(`in: ${toGoStringLiteral(scheme.in)}`, `name: ${toGoStringLiteral(scheme.name)}`);
  else return null;
  return `{${fields.join(", ")}}`;
}

// The arguments of an operation's authorize() call, or null if it needs no credentials the client
// can supply. An alternative using an unsupported scheme (e.g. http/basic, mutualTLS) is left to the
// caller's own *http.Client, which makes the requirement optional from the generated code's side -
// as does an explicit anonymous (`{}`) alternative.
function buildSecurity(operationLabel, security) {
  if (!security || security.length === 0) return null;
  const schemes = (schema.components && schema.components.securitySchemes) || {};
  const alternatives = [];
  let optional = false;
  for (const requirement of security) {
    const literals = Object.keys(requirement).map((name) => securityRequirementLiteral(name, schemes[name] || {}));
    if (literals.length === 0) {
      optional = true;
    } else if (literals.includes(null)) {
      optional = true;
      dump(
        `WARNING: ${operationLabel}: security requirement [${Object.keys(requirement).join(", ")}] uses a scheme other than ` +
          `http/bearer, oauth2, openIdConnect, or apiKey - authenticate it through the *http.Client`
      );
    } else {
      alternatives.push(`{${literals.join(", ")}}`);
    }
  }
  if (alternatives.length === 0) return null;
  return { optional, alternativesLiteral: `[][]securityRequirement{${alternatives.join(", ")}}` };
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
  // A raw body is taken as an io.Reader and streamed as-is (bytes.NewReader for in-memory data) -
  // nil means "absent" for an optional one, so it's never pointer-wrapped. A wildcard declared media
  // type ("application/*") isn't a valid Content-Type, so it's sent as application/octet-stream.
  if (picked.encoding === "bytes") {
    const wireMediaType = picked.mediaType.includes("*") ? "application/octet-stream" : picked.mediaType;
    return { type: "io.Reader", required, pointer: false, encoding: "bytes", mediaType: wireMediaType, mediaTypeLiteral: toGoStringLiteral(wireMediaType), fields: null };
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

// Describes how one success response's body is decoded: `kind` is "json" (a generated model type),
// "text" (string), "file" (*File - the body left open for the caller to stream or read) or "none"
// (no body, type null).
function buildResponseBody(registry, typeHint, statusCode, response) {
  const content = response.content || {};
  if (Object.keys(content).length === 0) return { type: null, kind: "none", statusCode };
  const jsonContent = content[JSON_MEDIA_TYPE];
  if (jsonContent) {
    const t = goType(registry, jsonContent.schema || {}, typeHint);
    return { type: qualifyModelType(t.type), kind: "json", statusCode };
  }
  const remaining = Object.keys(content);
  if (remaining.length === 1) {
    return isTextMediaType(remaining[0]) ? { type: "string", kind: "text", statusCode } : { type: FILE_TYPE, kind: "file", statusCode };
  }
  throw Error(
    `<2d5f8a4c> Unsupported response content-type(s) [${remaining.join(", ")}] for the ${statusCode} response - only ` +
      `"${JSON_MEDIA_TYPE}", a single "text/*" media type, or a single other media type (as *File) are supported`
  );
}

// Every explicitly numbered 2xx response, in ascending status code order - except a 206 whose
// single media type matches a raw 200's: that's the same body answering a Range request, decoded
// the same way as the 200, not a separate response variant.
function successResponseEntries(responses) {
  const codes = Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code))
    .sort();
  const mediaTypesOf = (code) => Object.keys((responses[code] && responses[code].content) || {});
  const ok = mediaTypesOf("200");
  const partial = mediaTypesOf("206");
  const partialIsRange =
    codes.includes("206") && ok.length === 1 && partial.length === 1 && ok[0] === partial[0] && ok[0] !== JSON_MEDIA_TYPE && !isTextMediaType(ok[0]);
  return codes.filter((code) => !(code === "206" && partialIsRange)).map((code) => ({ statusCode: code, response: responses[code] }));
}

// A single success response keeps the plain `(T, error)` method signature (decoded regardless of
// which 2xx status arrived). Two or more become a sealed interface with one struct per status code,
// picked by the actual response status.
function buildResponse(registry, hintBase, opName, responses, usedTypeNames) {
  const entries = successResponseEntries(responses || {});
  if (entries.length < 2) {
    const picked = entries[0] || firstSuccessResponse(responses || {});
    if (!picked) return { type: null, kind: "none", statusCode: 200, variants: null, keepsBody: false };
    const statusCode = /^\d+$/.test(picked.statusCode) ? parseInt(picked.statusCode, 10) : 200;
    const body = buildResponseBody(registry, hintBase + "Response", statusCode, picked.response);
    return { ...body, variants: null, keepsBody: body.kind === "file" };
  }
  const interfaceName = uniqueTypeName(opName + "Response", usedTypeNames);
  const variants = entries.map(({ statusCode, response }) => {
    const variantTypeName = uniqueTypeName(opName + statusCode + "Response", usedTypeNames);
    const summary = `${variantTypeName} is the ${statusCode} response${response.description ? ": " + response.description : "."}`;
    return {
      ...buildResponseBody(registry, hintBase + statusCode + "Response", parseInt(statusCode, 10), response),
      typeName: variantTypeName,
      docComment: buildDocComment(summary, null, [], "//"),
    };
  });
  return {
    type: interfaceName,
    kind: "variants",
    statusCode: null,
    markerMethod: "is" + interfaceName,
    variants,
    keepsBody: variants.some((v) => v.kind === "file"),
  };
}

function uniqueTypeName(base, usedTypeNames) {
  let name = base;
  let n = 2;
  while (usedTypeNames.has(name)) name = base + n++;
  usedTypeNames.add(name);
  return name;
}

// Looks up a tag's own document-level description (schema.tags: [{name, description}] - distinct
// from op.tags, which just lists tag NAMES on an operation).
function tagDescription(tagName) {
  const tag = (schema.tags || []).find((t) => t.name === tagName);
  return (tag && tag.description) || null;
}

// "byte" (not just "[]byte") because baseGoType strips a "[]" prefix before this lookup.
const BUILTIN_TYPES = new Set(["string", "int", "int32", "int64", "float32", "float64", "bool", "time.Time", "[]byte", "byte", "any"]);

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

// Types declared by client/runtime.go itself (or the standard library), not the models package.
const FILE_TYPE = "*File";
const NON_MODEL_TYPES = new Set([FILE_TYPE, "io.Reader"]);

// Names already declared at package level in client/runtime.go and client/ApiClient.go - a
// generated response variant type must never reuse one.
const RUNTIME_DECLARED_NAMES = ["File", "ResponseError", "MaxErrorBodySize", "Auth", "Option", "WithAuth", "ApiClient", "NewApiClient"];

function isModelType(t) {
  return !!t && !NON_MODEL_TYPES.has(t) && !BUILTIN_TYPES.has(baseGoType(t));
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
  const noteResponseBody = (r) => {
    if (r.type) noteType(r.type);
    if (r.kind === "json") flags.json = true;
  };
  const noteType = (t) => {
    if (isModelType(t)) flags.models = true;
    if (baseGoType(t) === "time.Time") flags.time = true;
  };
  for (const op of operations) {
    if (op.response.variants) op.response.variants.forEach(noteResponseBody);
    else noteResponseBody(op.response);
    if (op.queryParams.length > 0) flags.urlPkg = true;
    if (op.queryParams.some((p) => p.arraySeparator)) flags.strings = true;
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
  // Package-level type names generated into package client (response variant types) - unlike
  // method names, these share one namespace across every tag.
  const usedTypeNames = new Set(RUNTIME_DECLARED_NAMES);
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
        const response = buildResponse(registry, hintBase, opName, op.responses, usedTypeNames);
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
          security: buildSecurity(`operation ${op.method.toUpperCase()} ${op.path}`, op.security),
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
