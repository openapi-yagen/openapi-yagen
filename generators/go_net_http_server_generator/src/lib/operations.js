// Groups the engine's already-merged/deref'd collectOperations() by tag, and builds a fully
// precomputed description of each operation (parameter extraction/validation, auth, request/
// response types, Go handler-interface signature) so the .go.j2 templates stay close to flat
// printers instead of re-deriving logic.
//
// Everything here runs before any renderTemplate call (see main.js), while schema/parameter/
// response objects still have real JS identity - kindOf/constraintsOf/nameOf/firstSuccessResponse
// only work up to that point.

import { typeName, fieldName, paramName, operationName } from "./naming.js";
import { goType } from "./types.js";
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

function qualifyModelType(t) {
  if (!t) return t;
  if (t.startsWith("[]")) return "[]" + qualifyModelType(t.slice(2));
  if (t.startsWith("map[string]")) return "map[string]" + qualifyModelType(t.slice("map[string]".length));
  if (t.startsWith("models.")) return t;
  return isModelType(t) ? "models." + t : t;
}

// A query param whose (unwrapped) schema is Array-kind - serialized as repeated `?name=a&name=b`
// keys (OpenAPI 3's default `style: form, explode: true`).
function buildArrayQueryParam(registry, hintBase, p, itemSchema) {
  const itemT = goType(registry, itemSchema, hintBase + typeName(p.name) + "Item");
  const isSupported = isEnumType(registry, itemT.type) || SUPPORTED_SCALAR_PARAM_TYPES.has(itemT.type);
  if (!isSupported) {
    throw Error(
      `<01534acc> Unsupported query parameter array item type for "${p.name}": array items must be ` +
        `primitive scalar types (string/integer/number/boolean/date-time) or enums, got "${itemT.type}"`
    );
  }
  const qualifiedItemType = qualifyModelType(itemT.type);
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
    converter: converterFor(registry, itemT.type),
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
    converter: converterFor(registry, t.type),
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

// A single scheme's extraction call, as printed inside a generated `if v, err := ...; err == nil`
// condition - shared between the single-alternative (AND-only) route template loop and the
// OR-alternatives block built by buildAuthBlock below.
function authExtractCall(p) {
  return p.kind === "bearer" ? `RequireBearerToken(r, ${p.headerNameLiteral})` : `RequireAPIKey(r, ${p.locationLiteral}, ${p.nameLiteral})`;
}

// Renders the nested-if chain that attempts every scheme in one OR-alternative (an AND-combination
// within that alternative) in turn, assigning each to its (pointer-typed) handler-signature
// variable and setting `authMatched = true` only once every scheme in the chain has succeeded.
// Reuses the local names "v"/"err" at each nesting level - each `if` introduces its own block
// scope in Go, so no collision even when the same scheme appears in multiple alternatives.
function renderAuthChain(schemes, indent) {
  const [first, ...rest] = schemes;
  const body =
    rest.length === 0
      ? [`${indent}\t${first.goName} = &v`, `${indent}\tauthMatched = true`]
      : [`${indent}\t${first.goName} = &v`, ...renderAuthChain(rest, indent + "\t")];
  return [`${indent}if v, err := ${authExtractCall(first)}; err == nil {`, ...body, `${indent}}`];
}

// One OR-alternative: skipped entirely once an earlier alternative already matched. An empty
// alternative (`security: [{}, ...]`, meaning "no auth also allowed") always matches.
function renderAuthAlternative(schemes, indent) {
  const body = schemes.length === 0 ? [`${indent}\tauthMatched = true`] : renderAuthChain(schemes, indent + "\t");
  return [`${indent}if !authMatched {`, ...body, `${indent}}`];
}

// Builds the full Go source block that resolves which OR-alternative security requirement a
// request satisfies (2+ entries in the operation's `security` array): declares one `*string` var
// per distinct scheme referenced across every alternative, tries each alternative in the spec's
// declared order (first fully-satisfied one wins), and otherwise reports 401 via onError. Returns
// null for the (much more common) single-alternative case, which the route template still renders
// via its original flat per-param loop (required, non-pointer params, fail-fast per scheme).
function buildAuthBlock(alternatives) {
  const lines = [];
  const seen = new Set();
  for (const alt of alternatives) {
    for (const p of alt) {
      if (seen.has(p.goName)) continue;
      seen.add(p.goName);
      lines.push(`var ${p.goName} *string`);
    }
  }
  lines.push(`authMatched := false`);
  for (const alt of alternatives) lines.push(...renderAuthAlternative(alt, ""));
  lines.push(`if !authMatched {`);
  lines.push(`\tonError(w, r, &MissingAuthenticationError{msg: "no security requirement satisfied"})`);
  lines.push(`\treturn`);
  lines.push(`}`);
  return lines.join("\n");
}

// Returns { authParams, authBlock }. authParams is always the flat, deduplicated list of every
// scheme referenced by the operation's `security` (used to build the handler interface signature
// and call arguments); authBlock is non-null only for 2+ alternatives (OR) and holds the raw Go
// code the route template prints instead of its normal per-param extraction loop - see
// buildAuthBlock.
function buildAuthParams(security) {
  if (!security || security.length === 0) return { authParams: [], authBlock: null };
  const schemes = (schema.components && schema.components.securitySchemes) || {};
  if (security.length === 1) {
    const authParams = Object.keys(security[0]).map((schemeName) => buildAuthParamForScheme(schemeName, schemes[schemeName] || {}));
    return { authParams, authBlock: null };
  }
  // OR-alternatives: the same scheme name appearing in more than one alternative reuses the same
  // Go variable/param (built once, on first sight). Every scheme becomes a pointer param, since
  // whether it's populated depends on which alternative actually matched at request time.
  const byName = new Map();
  const alternatives = security.map((req) =>
    Object.keys(req).map((schemeName) => {
      if (!byName.has(schemeName)) {
        const p = buildAuthParamForScheme(schemeName, schemes[schemeName] || {});
        p.pointer = true;
        byName.set(schemeName, p);
      }
      return byName.get(schemeName);
    })
  );
  return { authParams: [...byName.values()], authBlock: buildAuthBlock(alternatives) };
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
  if (picked.encoding === "bytes") {
    return { type: "[]byte", required, pointer: !required, encoding: "bytes", fields: null, hasValidate: false };
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

function buildResponse(registry, hintBase, responses) {
  const picked = firstSuccessResponse(responses || {});
  if (!picked) return { type: null, statusCode: 200, mediaTypeLiteral: null };
  const statusCode = /^\d+$/.test(picked.statusCode) ? parseInt(picked.statusCode, 10) : 200;
  const content = picked.response.content || {};
  if (Object.keys(content).length === 0) return { type: null, statusCode, mediaTypeLiteral: null };
  const jsonContent = content[JSON_MEDIA_TYPE];
  if (jsonContent) {
    const t = goType(registry, jsonContent.schema || {}, hintBase + "Response");
    return { type: qualifyModelType(t.type), statusCode, mediaTypeLiteral: toGoStringLiteral(JSON_MEDIA_TYPE) };
  }
  const remaining = Object.keys(content);
  if (remaining.length === 1) {
    const mediaType = remaining[0];
    return { type: isTextMediaType(mediaType) ? "string" : "[]byte", statusCode, mediaTypeLiteral: toGoStringLiteral(mediaType) };
  }
  throw Error(
    `<2d5f8a4c> Unsupported response content-type(s) [${remaining.join(", ")}] for the success response - only ` +
      `"${JSON_MEDIA_TYPE}", a single "text/*" media type, or a single other media type (as []byte) are supported`
  );
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
    noteType(op.response.type);
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
  const flags = { strconv: false, io: false, models: false };
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
      if (op.body.encoding === "text" || op.body.encoding === "bytes") flags.io = true;
      // decodeJSONBody[T](r)'s T is printed literally; a urlencoded/multipart body's
      // reconstruction (`models.X{Field: ...}`) always names a model struct type too.
      if (op.body.encoding === "json" && isModelType(op.body.type)) flags.models = true;
      if (op.body.encoding === "urlencoded" || op.body.encoding === "multipart") flags.models = true;
      for (const f of op.body.fields || []) noteConverter(f.converter);
    }
    // A required array query/header param's "is required" check constructs a
    // &models.ValidationError{...} directly.
    if ([...op.queryParams, ...op.headerParams].some((p) => p.isArray && p.required)) flags.models = true;
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

// Returns a Map<tag, { handlerType, registerFunc, description, operations: [...], imports }> in
// path-declaration order.
export function collectOperationsByTag(registry) {
  const groups = new Map();
  const usedNamesByTag = new Map();
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
        const { authParams, authBlock } = buildAuthParams(op.security);

        const body = buildRequestBody(registry, hintBase, op.requestBody);
        const response = buildResponse(registry, hintBase, op.responses);

        const sigParts = ["ctx context.Context", ...allParams.map(paramSig), ...authParams.map(paramSig)];
        if (body) sigParts.push(`body ${body.pointer ? "*" : ""}${body.type}`);
        const signature = sigParts.join(", ");

        const callArgs = [
          "r.Context()",
          ...allParams.map((p) => p.goName),
          ...authParams.map((p) => p.goName),
          ...(body ? ["body"] : []),
        ].join(", ");

        if (!groups.has(tag)) groups.set(tag, { handlerType, registerFunc: `Register${typeName(tag)}Routes`, description: tagDescription(tag), operations: [] });
        groups.get(tag).operations.push({
          name: opName,
          method: op.method.toUpperCase(),
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
          authBlock,
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
