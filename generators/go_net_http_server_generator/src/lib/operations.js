// Groups the engine's already-merged/deref'd collectOperations() by tag, and builds a fully
// precomputed description of each operation (parameter extraction/validation, auth, request/
// response types, Go handler-interface signature) so the .go.j2 templates stay close to flat
// printers instead of re-deriving logic.
//
// Everything here runs before any renderTemplate call (see main.js), while schema/parameter/
// response objects still have real JS identity - kindOf/constraintsOf/nameOf/firstSuccessResponse
// only work up to that point.

import { typeName, fieldName, paramName, operationName } from "./naming.js";
import { goType, openEnumValues } from "./types.js";
import { underlyingType } from "./validation.js";
import { toGoStringLiteral } from "./keywords.js";
import { withResilience } from "./strict.js";

// Go scalar types a path/query/header param can resolve to.
const SUPPORTED_SCALAR_PARAM_TYPES = new Set(["string", "int", "int32", "int64", "float32", "float64", "bool", "time.Time"]);

// Maps a supported scalar/enum Go type to the name of a `func(string) (T, error)` converter
// defined in server/runtime.go (or, for an enum, generated directly onto the model in
// models/<Name>.go) - the generic pathParamAs/queryParamAs/... helpers take this as their last
// argument, so param extraction never needs a bespoke parse-and-check block per operation.
function converterFor(registry, type) {
  const CONVERTERS = {
    string: "parseString",
    int: "strconv.Atoi",
    int32: "parseInt32",
    int64: "parseInt64",
    float32: "parseFloat32",
    float64: "parseFloat64",
    bool: "strconv.ParseBool",
    "time.Time": "parseRFC3339",
  };
  if (CONVERTERS[type]) return CONVERTERS[type];
  const model = registry.models.get(type.replace(/^models\./, ""));
  if (model && model.kind === "enum") return `models.Parse${model.name}`;
  return null;
}

function isEnumType(registry, typeStr) {
  const m = registry.models.get(typeStr);
  return !!m && m.kind === "enum";
}

// A oneOf/anyOf in parameter position can't reuse the JSON-shape-dispatching union model - a
// path/query/header value is always just a string on the wire. If every variant is itself
// primitive-like (no object/array variant), it's passed through as a plain, unparsed string.
function isPrimitiveLikeUnion(schema) {
  const kind = kindOf(schema);
  if (kind !== "OneOf" && kind !== "AnyOf") return false;
  const variants = schema.oneOf || schema.anyOf || [];
  return variants.length > 0 && variants.every((v) => ["Primitive", "Enum"].includes(kindOf(v)));
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

// Types declared by server/runtime.go itself (not the models package) that can appear in a handler
// signature.
const BINARY_BODY_TYPE = "*BinaryBody";
const FILE_TYPE = "File";
const SERVER_TYPES = new Set([BINARY_BODY_TYPE, FILE_TYPE]);

// Names already declared at package level in server/runtime.go (plus per-tag Register*/*Routes
// functions, checked separately) - a generated response variant type must never reuse one.
const RUNTIME_DECLARED_NAMES = [
  "BinaryBody",
  "File",
  "Router",
  "Route",
  "Routes",
  "ErrorHandler",
  "DefaultErrorHandler",
  "MissingAuthenticationError",
  "UnsupportedMediaTypeError",
  "RequireBearerToken",
  "RequireAPIKey",
  "RequestFromContext",
  "ResponseWriterFromContext",
  "OpenAPISpec",
  "RegisterOpenApiSpecRoute",
];

function isModelType(t) {
  return !!t && !SERVER_TYPES.has(t) && !BUILTIN_TYPES.has(baseGoType(t));
}

function qualifyModelType(t) {
  if (!t) return t;
  if (t.startsWith("[]")) return "[]" + qualifyModelType(t.slice(2));
  if (t.startsWith("map[string]")) return "map[string]" + qualifyModelType(t.slice("map[string]".length));
  if (t.startsWith("models.")) return t;
  return isModelType(t) ? "models." + t : t;
}

// A named scalar schema (e.g. `type TenantID string`) used by a parameter is passed as the scalar
// it's defined over - parameters have no use for the named type's own methods (it has none).
function resolveScalarAlias(registry, type) {
  const model = registry.models.get(type);
  return model && model.kind === "alias" ? underlyingType(registry, model.targetType) : type;
}

// ECMA-262 regex constructs Go's regexp (RE2) rejects: lookarounds, backreferences, \u and \c escapes.
const RE2_UNSUPPORTED_PATTERN = /\(\?<?[=!]|\\[1-9]|\\u|\\c/;

// The extra arguments a parameter helper (server/runtime.go) takes to validate the converted value
// against the schema's constraints - the same set models' Validate() checks.
function paramCheckArgs(registry, name, schema, type) {
  const c = constraintsOf(schema);
  const underlying = underlyingType(registry, type);
  const goTypeArg = qualifyModelType(type);
  const checks = [];
  if (["int", "int32", "int64", "float32", "float64"].includes(underlying)) {
    if (c.minimum !== undefined) checks.push(`checkMin[${goTypeArg}](${c.minimum})`);
    if (c.maximum !== undefined) checks.push(`checkMax[${goTypeArg}](${c.maximum})`);
  }
  if (underlying === "string") {
    if (c.minLength !== undefined) checks.push(`checkMinLength[${goTypeArg}](${c.minLength})`);
    if (c.maxLength !== undefined) checks.push(`checkMaxLength[${goTypeArg}](${c.maxLength})`);
    if (c.pattern !== undefined) {
      if (RE2_UNSUPPORTED_PATTERN.test(c.pattern)) {
        dump(`WARNING: parameter "${name}": pattern ${c.pattern} isn't supported by Go's regexp package, so it isn't checked`);
      } else {
        checks.push(`checkPattern[${goTypeArg}](${toGoStringLiteral(c.pattern)})`);
      }
    }
    if (schema.format === "uuid") checks.push(`checkUUID[${goTypeArg}]`);
    if (schema.format === "date") checks.push(`checkDate[${goTypeArg}]`);
  }
  return checks.map((check) => ", " + check).join("");
}

// A query param whose (unwrapped) schema is Array-kind - serialized as repeated `?name=a&name=b`
// keys (OpenAPI 3's default `style: form, explode: true`).
function buildArrayQueryParam(registry, hintBase, p, itemSchema) {
  const itemType = resolveScalarAlias(registry, goType(registry, itemSchema, hintBase + typeName(p.name) + "Item").type);
  const isSupported = isEnumType(registry, itemType) || SUPPORTED_SCALAR_PARAM_TYPES.has(itemType);
  if (!isSupported) {
    throw Error(
      `<01534acc> Unsupported query parameter array item type for "${p.name}": array items must be ` +
        `primitive scalar types (string/integer/number/boolean/date-time) or enums, got "${itemType}"`
    );
  }
  const qualifiedItemType = qualifyModelType(itemType);
  return {
    goName: paramName(p.name),
    wireName: p.name,
    wireNameLiteral: toGoStringLiteral(p.name),
    in: p.in,
    type: `[]${qualifiedItemType}`,
    itemType: qualifiedItemType,
    isArray: true,
    required: !!p.required,
    pointer: false,
    converter: converterFor(registry, itemType),
    checkArgs: paramCheckArgs(registry, p.name, unwrapSchema(itemSchema), itemType),
    description: p.description || null,
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
    converter: converterFor(registry, type),
    checkArgs: isPlainString ? "" : paramCheckArgs(registry, p.name, resolved, type),
    description: p.description || null,
  };
}

function paramSig(p) {
  return `${p.goName} ${p.pointer ? "*" : ""}${p.type}`;
}

// Only `http`/`bearer`, `apiKey`, `oauth2`, and `openIdConnect` security schemes are supported.
// oauth2/openIdConnect are handled identically to `http`/`bearer`: per RFC 6750, an OAuth2/OIDC
// access token travels as `Authorization: Bearer <token>` regardless of how it was obtained
// (authorization-code, client-credentials, ...), and this generator never validates a token's
// signature/scopes/audience for any scheme - that's left entirely to the handler implementation,
// consistent with how bearer/apiKey are already just "is a value present" extraction. Only the Go
// param name (derived from schemeName) differs by scheme.
function buildAuthParamForScheme(schemeName, scheme) {
  const isBearerLike = (scheme.type === "http" && (scheme.scheme || "").toLowerCase() === "bearer") || scheme.type === "oauth2" || scheme.type === "openIdConnect";
  if (isBearerLike) {
    return {
      schemeName,
      goName: paramName(schemeName + "Token"),
      type: "string",
      pointer: false,
      kind: "bearer",
      headerNameLiteral: toGoStringLiteral("Authorization"),
    };
  }
  if (scheme.type === "apiKey") {
    return {
      schemeName,
      goName: paramName(schemeName + "Key"),
      type: "string",
      pointer: false,
      kind: "apiKey",
      locationLiteral: toGoStringLiteral(scheme.in),
      nameLiteral: toGoStringLiteral(scheme.name),
    };
  }
  throw Error(
    `<9b6a1e3f> Unsupported security scheme type "${scheme.type}" for "${schemeName}" - only "http" (bearer), "apiKey", "oauth2", and "openIdConnect" schemes are supported`
  );
}

// Returns { authParams, authAlternatives }. authParams is always the flat, deduplicated list of
// every scheme referenced by the operation's `security` (used to build the handler interface
// signature and call arguments); authAlternatives is non-null only for 2+ alternatives (OR) -
// server_routes.go.j2's authTry/authAlternative macros recurse over it directly to render the
// nested-if resolution chain (tries each alternative in the spec's declared order, first
// fully-satisfied one wins), rather than this JS building that Go source as a raw string itself.
function buildAuthParams(security) {
  if (!security || security.length === 0) return { authParams: [], authAlternatives: null };
  const schemes = (schema.components && schema.components.securitySchemes) || {};
  if (security.length === 1) {
    const authParams = Object.keys(security[0]).map((schemeName) => buildAuthParamForScheme(schemeName, schemes[schemeName] || {}));
    return { authParams, authAlternatives: null };
  }
  // OR-alternatives: the same scheme name appearing in more than one alternative reuses the same
  // Go variable/param (built once, on first sight). Every scheme becomes a pointer param, since
  // whether it's populated depends on which alternative actually matched at request time.
  const byName = new Map();
  const authAlternatives = security.map((req) =>
    Object.keys(req).map((schemeName) => {
      if (!byName.has(schemeName)) {
        const p = buildAuthParamForScheme(schemeName, schemes[schemeName] || {});
        p.pointer = true;
        byName.set(schemeName, p);
      }
      return byName.get(schemeName);
    })
  );
  return { authParams: [...byName.values()], authAlternatives };
}

// Go 1.22's http.ServeMux pattern syntax ("METHOD /pets/{petId}") uses the exact same "{name}"
// wildcard syntax OpenAPI path templates already do - no translation needed.
function buildPathPattern(method, pathStr) {
  return `${method} ${pathStr}`;
}

const JSON_MEDIA_TYPE = "application/json";
const MULTIPART_MEDIA_TYPE = "multipart/form-data";
const URLENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded";

function isTextMediaType(mediaType) {
  return mediaType.startsWith("text/");
}

// A field is also allowed to be an Array of primitive/enum items - sent as a repeated form key
// (`tags=a&tags=b`), the same `style: form, explode: true` convention buildArrayQueryParam already
// uses for array-typed query parameters. An object-shaped or array-of-array/object field is still
// unsupported: multipart/urlencoded have no standard convention for either (unlike a repeated
// scalar key, which HTML forms have used for arrays forever), so inventing one here would be an
// arbitrary generator-specific encoding real API clients wouldn't know to produce.
function requireFlatObjectSchema(bodySchema, mediaType) {
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
    return { type: "string", required, pointer: !required, encoding: "text", fields: null, hasValidate: false };
  }
  // A raw (non-JSON/form/text) body is handed to the handler as a *BinaryBody (server/runtime.go)
  // wrapping the still-unread request stream, so each handler implementation decides per operation
  // whether to stream it (io.Reader + Limit) or just buffer it (Bytes()). Already a pointer - nil
  // means "absent" for an optional body - so never wrapped in a second one.
  if (picked.encoding === "bytes") {
    return {
      type: BINARY_BODY_TYPE,
      required,
      pointer: false,
      encoding: "bytes",
      fields: null,
      hasValidate: false,
      mediaTypeLiteral: toGoStringLiteral(picked.mediaType),
    };
  }
  if (picked.encoding !== "json") requireFlatObjectSchema(bodySchema, picked.mediaType);
  const t = goType(registry, bodySchema, hintBase + "Body");
  const model = registry.models.get(t.type);
  const rawFields = picked.encoding !== "json" ? (model || {}).properties || [] : null;
  // Attach the extra fields the template needs directly onto each property object (rather than
  // mapping to a fresh copy) - .pointer isn't set on these yet (finalizeModels runs after
  // collectOperationsByTag, see main.js/types.js), so this must stay the SAME object finalizeModels
  // will later mutate in place, not a snapshot taken before that happens.
  if (rawFields) {
    for (const f of rawFields) {
      f.localName = paramName(f.wireName);
      f.wireNameLiteral = toGoStringLiteral(f.wireName);
      // A multipart `format: binary` field is an actual uploaded file part (read via
      // r.FormFile), not a text form value - overwrite its Go type to []byte here (mutating the
      // SAME shared property object other model files reference, same reasoning as the comment
      // above: this runs before finalizeModels, so it sees the final type). urlencoded has no
      // file-part concept, so a urlencoded `format: binary` field is left as a plain string field,
      // unchanged. []byte is itself a ref-type (see types.js's isRefType), so - like an array
      // field - it's never pointer-wrapped; "required" is enforced with an explicit nil check in
      // the template instead, the same way a required array query/header param already is.
      f.isFile = picked.encoding === "multipart" && f.format === "binary";
      if (f.isFile) {
        f.type = "[]byte";
        f.isArray = false;
        f.itemType = null;
        f.converter = null;
      } else if (f.type.startsWith("[]")) {
        f.isArray = true;
        f.itemType = f.type.slice(2);
        f.converter = converterFor(registry, f.itemType);
      } else {
        f.isArray = false;
        f.itemType = null;
        f.converter = converterFor(registry, f.type);
      }
    }
  }
  return {
    type: qualifyModelType(t.type),
    required,
    pointer: !required,
    encoding: picked.encoding,
    fields: rawFields,
    hasValidate: picked.encoding === "json" && !!model && model.kind === "object",
  };
}

// Describes how one success response's body is written: `kind` is "json" (writeJSON), "text"
// (string), "file" (File, via writeFile) or "none" (status code only, type null).
function buildResponseBody(registry, typeHint, statusCode, response) {
  const content = response.content || {};
  if (Object.keys(content).length === 0) return { type: null, kind: "none", statusCode, mediaType: null, mediaTypeLiteral: null };
  const jsonContent = content[JSON_MEDIA_TYPE];
  if (jsonContent) {
    const t = goType(registry, jsonContent.schema || {}, typeHint);
    return { type: qualifyModelType(t.type), kind: "json", statusCode, mediaType: JSON_MEDIA_TYPE, mediaTypeLiteral: toGoStringLiteral(JSON_MEDIA_TYPE) };
  }
  const remaining = Object.keys(content);
  if (remaining.length === 1) {
    const mediaType = remaining[0];
    const isText = isTextMediaType(mediaType);
    return { type: isText ? "string" : FILE_TYPE, kind: isText ? "text" : "file", statusCode, mediaType, mediaTypeLiteral: toGoStringLiteral(mediaType) };
  }
  throw Error(
    `<2d5f8a4c> Unsupported response content-type(s) [${remaining.join(", ")}] for the ${statusCode} response - only ` +
      `"${JSON_MEDIA_TYPE}", a single "text/*" media type, or a single other media type (as File) are supported`
  );
}

// Every explicitly numbered 2xx response, in ascending status code order - except a 206 whose
// single media type matches a binary 200's: http.ServeContent already produces that 206 itself
// (for a Range request against a seekable File), so it's not a separate variant the handler picks.
function successResponseEntries(responses) {
  const codes = Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code))
    .sort();
  const mediaTypesOf = (code) => Object.keys((responses[code] && responses[code].content) || {});
  const ok = mediaTypesOf("200");
  const partial = mediaTypesOf("206");
  const partialIsServeContent =
    codes.includes("206") && ok.length === 1 && partial.length === 1 && ok[0] === partial[0] && ok[0] !== JSON_MEDIA_TYPE && !isTextMediaType(ok[0]);
  return codes.filter((code) => !(code === "206" && partialIsServeContent)).map((code) => ({ statusCode: code, response: responses[code] }));
}

// A single success response keeps the plain `(T, error)` handler signature. Two or more (e.g. 200
// for a synchronous result, 202 for an accepted background job) become a sealed interface with one
// struct per status code, so the handler picks the status at runtime by which variant it returns.
function buildResponse(registry, hintBase, opName, responses, usedTypeNames) {
  const entries = successResponseEntries(responses || {});
  if (entries.length < 2) {
    const picked = entries[0] || firstSuccessResponse(responses || {});
    if (!picked) return { type: null, kind: "none", statusCode: 200, mediaTypeLiteral: null, variants: null };
    const statusCode = /^\d+$/.test(picked.statusCode) ? parseInt(picked.statusCode, 10) : 200;
    return { ...buildResponseBody(registry, hintBase + "Response", statusCode, picked.response), variants: null };
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
    mediaTypeLiteral: null,
    markerMethod: "is" + interfaceName,
    variants,
    anyVariantHasBody: variants.some((v) => v.type !== null),
  };
}

function uniqueTypeName(base, usedTypeNames) {
  let name = base;
  let n = 2;
  while (usedTypeNames.has(name)) name = base + n++;
  usedTypeNames.add(name);
  return name;
}

function tagDescription(tagName) {
  const tag = (schema.tags || []).find((t) => t.name === tagName);
  return (tag && tag.description) || null;
}

// server_handler.go.j2 prints every param/body/response Go type in full (the interface method
// signature), so its import needs follow directly from which types appear anywhere in an
// operation's signature.
function computeHandlerImportFlags(operations) {
  const flags = { models: false, time: false };
  const noteType = (t) => {
    if (!t) return;
    if (isModelType(t)) flags.models = true;
    if (baseGoType(t) === "time.Time") flags.time = true;
  };
  for (const op of operations) {
    if (op.response.variants) for (const v of op.response.variants) noteType(v.type);
    else noteType(op.response.type);
    for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...op.cookieParams, ...op.authParams]) noteType(p.itemType || p.type);
    if (op.body) noteType(op.body.type);
  }
  return flags;
}

// server_routes.go.j2, unlike the handler file, only ever prints a package-qualified type name at
// a handful of specific spots (never as a `var x T` declaration - every local is `:=`-inferred),
// so its import needs are narrower than "any type in this tag's operations" and have to mirror
// exactly where the template itself writes a qualified name, or Go's unused-import check fails.
function computeRoutesImportFlags(operations) {
  const flags = { strconv: false, io: false, fmt: false, models: false };
  // The converter passed to pathParamAs/queryParamAs/.../formFieldAs is printed as literal Go
  // source (e.g. "strconv.Atoi", or "models.ParseStatus" for an enum-typed param/field) - a
  // package-qualified converter name means that package is referenced directly in this file.
  const noteConverter = (converter) => {
    if (!converter) return;
    if (converter.startsWith("strconv.")) flags.strconv = true;
    if (converter.startsWith("models.")) flags.models = true;
  };
  for (const op of operations) {
    for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...op.cookieParams]) noteConverter(p.converter);
    if (op.body) {
      if (op.body.encoding === "text") flags.io = true;
      // decodeJSONBody[T](r)'s T is printed literally; a urlencoded/multipart body's
      // reconstruction (`models.X{Field: ...}`) always names a model struct type too.
      if (op.body.encoding === "json" && isModelType(op.body.type)) flags.models = true;
      if (op.body.encoding === "urlencoded" || op.body.encoding === "multipart") flags.models = true;
      for (const f of op.body.fields || []) noteConverter(f.converter);
    }
    // A required array query/header param's "is required" check constructs a
    // &models.ValidationError{...} directly.
    if ([...op.queryParams, ...op.headerParams].some((p) => p.isArray && p.required)) flags.models = true;
    // An unexpected response variant is reported via fmt.Errorf.
    if (op.response.variants) flags.fmt = true;
  }
  return flags;
}

// Disambiguates a tag's method name against every other method name already generated for that
// same tag - real-world specs sometimes reuse one operationId across multiple methods on the same
// path (e.g. a single "WidgetEntities" operationId for both GET and POST), which would otherwise
// generate two methods with the exact same name on the same handler interface.
function disambiguateOperationName(base, method, usedNames) {
  if (!usedNames.has(base)) return base;
  const withMethod = base + toPascalCase(method);
  if (!usedNames.has(withMethod)) return withMethod;
  let n = 2;
  while (usedNames.has(withMethod + n)) n++;
  return withMethod + n;
}

// Returns a Map<tag, { handlerType, registerFunc, routesFunc, description, operations: [...], imports }>
// in path-declaration order.
export function collectOperationsByTag(registry) {
  const groups = new Map();
  const usedNamesByTag = new Map();
  // Package-level type names generated into package server (response variant types) - unlike
  // method names, these share one namespace across every tag.
  const usedTypeNames = new Set(RUNTIME_DECLARED_NAMES);
  for (const op of collectOperations()) {
    withResilience(
      `operation ${op.method.toUpperCase()} ${op.path}`,
      () => {
        const tag = (op.tags && op.tags[0]) || "Default";
        const handlerType = typeName(tag) + "Handler";
        if (!usedNamesByTag.has(tag)) usedNamesByTag.set(tag, new Set());
        const usedNames = usedNamesByTag.get(tag);
        const opName = disambiguateOperationName(operationName(op.method, op.path, op.operationId), op.method, usedNames);
        usedNames.add(opName);
        const hintBase = handlerType + opName;

        const allParams = op.parameters.map((p) => buildParam(registry, hintBase, p));
        const pathParams = allParams.filter((p) => p.in === "path");
        const queryParams = allParams.filter((p) => p.in === "query");
        const headerParams = allParams.filter((p) => p.in === "header");
        const cookieParams = allParams.filter((p) => p.in === "cookie");
        const { authParams, authAlternatives } = buildAuthParams(op.security);

        const body = buildRequestBody(registry, hintBase, op.requestBody);
        const response = buildResponse(registry, hintBase, opName, op.responses, usedTypeNames);

        const sigParts = ["ctx context.Context", ...allParams.map(paramSig), ...authParams.map(paramSig)];
        if (body) sigParts.push(`body ${body.pointer ? "*" : ""}${body.type}`);
        const signature = sigParts.join(", ");

        const callArgs = [
          "r.Context()",
          ...allParams.map((p) => p.goName),
          ...authParams.map((p) => p.goName),
          ...(body ? ["body"] : []),
        ].join(", ");

        if (!groups.has(tag)) {
          groups.set(tag, {
            tag,
            tagLiteral: toGoStringLiteral(tag),
            handlerType,
            registerFunc: `Register${typeName(tag)}Routes`,
            routesFunc: `${typeName(tag)}Routes`,
            description: tagDescription(tag),
            operations: [],
          });
        }
        groups.get(tag).operations.push({
          name: opName,
          method: op.method.toUpperCase(),
          methodLiteral: toGoStringLiteral(op.method.toUpperCase()),
          pathLiteral: toGoStringLiteral(op.path),
          operationIdLiteral: toGoStringLiteral(op.operationId || ""),
          pattern: toGoStringLiteral(buildPathPattern(op.method.toUpperCase(), op.path)),
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
          authParams,
          authAlternatives,
          body,
          response,
          returnsValue: response.type !== null,
          signature,
          callArgs,
        });
      },
      () => {} // permissive mode: drop this operation, keep the rest of the group as-is
    );
  }
  for (const group of groups.values()) {
    group.handlerImports = computeHandlerImportFlags(group.operations);
    group.routesImports = computeRoutesImportFlags(group.operations);
  }
  return groups;
}
