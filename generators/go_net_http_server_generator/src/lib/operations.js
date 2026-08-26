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

// Only `http`/`bearer` and `apiKey` security schemes are supported. A security requirement with
// 2+ alternatives (OR) has no single combination of handler parameters that covers every
// alternative, so it's unsupported (same restriction the Kotlin server generator this mirrors
// applies) - one AND-combination (every scheme in a single requirement entry) is fine.
function buildAuthParamForScheme(schemeName, scheme) {
  if (scheme.type === "http" && (scheme.scheme || "").toLowerCase() === "bearer") {
    return {
      goName: paramName(schemeName + "Token"),
      type: "string",
      pointer: false,
      kind: "bearer",
      headerNameLiteral: toGoStringLiteral("Authorization"),
    };
  }
  if (scheme.type === "apiKey") {
    return {
      goName: paramName(schemeName + "Key"),
      type: "string",
      pointer: false,
      kind: "apiKey",
      locationLiteral: toGoStringLiteral(scheme.in),
      nameLiteral: toGoStringLiteral(scheme.name),
    };
  }
  throw Error(
    `<9b6a1e3f> Unsupported security scheme type "${scheme.type}" for "${schemeName}" - only "http" (bearer) and "apiKey" schemes are supported`
  );
}

function buildAuthParams(security) {
  if (!security || security.length === 0) return [];
  if (security.length > 1) {
    throw Error(`<c4d8f271> Unsupported security requirement: multiple alternative (OR) security requirements are not supported`);
  }
  const schemes = (schema.components && schema.components.securitySchemes) || {};
  return Object.keys(security[0]).map((schemeName) => buildAuthParamForScheme(schemeName, schemes[schemeName] || {}));
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
      f.converter = converterFor(registry, f.type);
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
    for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams, ...op.authParams]) noteType(p.itemType || p.type);
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
    for (const p of [...op.pathParams, ...op.queryParams, ...op.headerParams]) noteConverter(p.converter);
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
        const authParams = buildAuthParams(op.security);

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
          authParams,
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
