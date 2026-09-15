// Groups the engine's already-merged/deref'd collectOperations() by tag and builds a fully
// precomputed description of each operation (route pattern, parameter extraction/validation
// statements, request body decoding, response encoding, auth extraction) so
// templates/controller.rb.j2/routes.rb.j2/handlers.rb.j2 stay flat printers - same discipline as
// the sibling server generators' own lib/operations.js (see python_tornado_server_generator's).
//
// Forked in spirit from ruby_faraday_client_generator's lib/operations.js (same content-type/
// param-shape POLICY - see pickBodyContent/requireFlatObjectSchema below, ported near-verbatim),
// but the actual generated code is entirely different: a client BUILDS a request from an
// already-correctly-typed Ruby value; a server PARSES untrusted wire input (a String from Rails'
// `params`, a request header, a request body) into one - every parameter here carries a list of
// Ruby statements (not a single expression) doing that parse-and-validate, following this
// project's "heavy logic in JS, templates are near-mechanical printers" convention (see
// python_tornado_server_generator's own lib/operations.js).

import { className, paramName, operationName } from "./naming.js";
import { rubyType } from "./types.js";
import { buildFromHExpr, buildToWireExpr } from "./serialization.js";
import { withResilience } from "./strict.js";

function requireScalarOrEnum(p, position) {
  const resolved = unwrapSchema(p.schema || { type: "string" });
  const kind = kindOf(resolved);
  if (kind !== "Primitive" && kind !== "Enum") {
    throw Error(
      `<a4e7c9b2> Unsupported ${position} parameter type for "${p.name}": only primitive scalar ` +
        `types (string/number/boolean) or enums are supported in ${position} position`
    );
  }
  return resolved;
}

// Returns { label, statements } - `statements` is the list of Ruby statements that reassign the
// already-fetched raw value bound to `varName` in place, converting/validating it according to
// `resolved`'s type/format. Nil-safe throughout (every runtime.rb parse_*/require_* helper this
// calls is a no-op on nil - see runtime.rb) - safe to run unconditionally even when the parameter
// turned out absent, so the caller never needs an `unless value.nil?` guard around this.
function scalarConversionStatements(registry, resolved, hintName, varName, fieldLiteral) {
  const kind = kindOf(resolved);
  if (kind === "Enum") {
    const t = rubyType(registry, resolved, hintName);
    const stmts = [];
    if (resolved.type === "integer") stmts.push(`${varName} = Runtime.parse_int(${varName}, ${fieldLiteral})`);
    else if (resolved.type === "number") stmts.push(`${varName} = Runtime.parse_float(${varName}, ${fieldLiteral})`);
    stmts.push(`Runtime.require_enum(${varName}, ${t.label}::ALL_VALUES, ${fieldLiteral})`);
    return { label: t.label, statements: stmts };
  }
  if (resolved.type === "string" && resolved.format === "date") {
    return { label: "Date", statements: [`${varName} = Runtime.parse_date_param(${varName}, ${fieldLiteral})`] };
  }
  if (resolved.type === "string" && resolved.format === "date-time") {
    return { label: "Time", statements: [`${varName} = Runtime.parse_datetime_param(${varName}, ${fieldLiteral})`] };
  }
  if (resolved.type === "integer") {
    return { label: "Integer", statements: [`${varName} = Runtime.parse_int(${varName}, ${fieldLiteral})`] };
  }
  if (resolved.type === "number") {
    return { label: "Float", statements: [`${varName} = Runtime.parse_float(${varName}, ${fieldLiteral})`] };
  }
  if (resolved.type === "boolean") {
    return { label: "Boolean", statements: [`${varName} = Runtime.parse_bool(${varName}, ${fieldLiteral})`] };
  }
  // A plain string - format:uuid gets a shape check but no type conversion (already a String).
  const stmts = resolved.format === "uuid" ? [`Runtime.require_uuid(${varName}, ${fieldLiteral})`] : [];
  return { label: "String", statements: stmts };
}

// A required path segment is always present once the route has matched (Rails wouldn't have
// dispatched otherwise) - no presence check needed, unlike query/header/cookie. The route
// PATTERN itself uses this same rubyName as its `:segment` (see buildRailsPathPattern) - a path
// parameter has no separate "wire name" the way a query/header/cookie parameter does, since
// nothing about it is a client-chosen key: the value's POSITION in the URL is what identifies it.
function buildPathParam(registry, hintBase, p) {
  const resolved = requireScalarOrEnum(p, "path");
  const rubyName = paramName(p.name);
  const field = toStringLiteral(p.name);
  const conv = scalarConversionStatements(registry, resolved, hintBase + className(p.name), rubyName, field);
  return {
    rubyName,
    wireName: p.name,
    required: true,
    description: p.description || null,
    label: conv.label,
    statements: [`${rubyName} = params[:${rubyName}]`, ...conv.statements],
  };
}

function buildHeaderParam(registry, hintBase, p) {
  const resolved = requireScalarOrEnum(p, "header");
  const rubyName = paramName(p.name);
  const field = toStringLiteral(p.name);
  const required = !!p.required;
  const conv = scalarConversionStatements(registry, resolved, hintBase + className(p.name), rubyName, field);
  const fetch = required ? `Runtime.require_header(request, ${field})` : `Runtime.header(request, ${field})`;
  return {
    rubyName,
    wireName: p.name,
    required,
    description: p.description || null,
    label: conv.label,
    statements: [`${rubyName} = ${fetch}`, ...conv.statements],
  };
}

// A Rails controller isn't browser-sandboxed the way a fetch-based client is - reading an
// incoming Cookie header is a completely ordinary, always-supported operation (see
// runtime.rb#cookie), unlike the TypeScript fetch client generator's own rejection of `in: cookie`.
function buildCookieParam(registry, hintBase, p) {
  const resolved = requireScalarOrEnum(p, "cookie");
  const rubyName = paramName(p.name);
  const field = toStringLiteral(p.name);
  const required = !!p.required;
  const conv = scalarConversionStatements(registry, resolved, hintBase + className(p.name), rubyName, field);
  const fetch = required ? `Runtime.require_cookie(request, ${field})` : `Runtime.cookie(request, ${field})`;
  return {
    rubyName,
    wireName: p.name,
    required,
    description: p.description || null,
    label: conv.label,
    statements: [`${rubyName} = ${fetch}`, ...conv.statements],
  };
}

// Unlike ruby_faraday_client_generator's own buildQueryParam (which passes a query parameter
// through untouched, since the OUTGOING shape is whatever the caller's Ruby value already is),
// a server has to PARSE a query parameter's wire String(s) into a typed value - so this generator
// restricts query parameters to a scalar/enum, or an array of either, the same restriction
// path/header/cookie parameters already have (see requireScalarOrEnum) - a bare object/deepObject
// query parameter (which that generator's client-only build_query walks generically at request
// time) has no analogous "parse this generically" story on the receiving end, so it's a generator
// error here, same "handle the common case" scope as everywhere else in this project.
function buildQueryParam(registry, hintBase, p) {
  const resolved = unwrapSchema(p.schema || { type: "string" });
  const kind = kindOf(resolved);
  const rubyName = paramName(p.name);
  const field = toStringLiteral(p.name);
  const required = !!p.required;

  if (kind === "Array") {
    const itemResolved = unwrapSchema(resolved.items || {});
    const itemKind = kindOf(itemResolved);
    if (itemKind !== "Primitive" && itemKind !== "Enum") {
      throw Error(
        `<b8d1f6a3> Unsupported query parameter type for "${p.name}": array items must be primitive ` +
          `scalar types or enums - got ${itemKind}`
      );
    }
    const itemVar = `${rubyName}_item`;
    const itemConv = scalarConversionStatements(registry, itemResolved, hintBase + className(p.name) + "Item", itemVar, field);
    const statements = [`${rubyName} = Runtime.query_array(request, ${field})`];
    if (required) statements.push(`raise Runtime::ValidationError, "\\"${p.name}\\" is required" if ${rubyName}.empty?`);
    if (itemConv.statements.length > 0) {
      statements.push(`${rubyName} = ${rubyName}.map { |${itemVar}| ${itemConv.statements.join("; ")}; ${itemVar} }`);
    }
    return { rubyName, wireName: p.name, required, description: p.description || null, label: `Array<${itemConv.label}>`, statements, isArray: true };
  }

  if (kind !== "Primitive" && kind !== "Enum") {
    throw Error(
      `<f2c8a4e9> Unsupported query parameter type for "${p.name}": only primitive scalar types, ` +
        `enums, or arrays of either are supported - got ${kind}`
    );
  }
  const conv = scalarConversionStatements(registry, resolved, hintBase + className(p.name), rubyName, field);
  const fetch = required ? `Runtime.require_param(params, ${field})` : `Runtime.param(params, ${field})`;
  return {
    rubyName,
    wireName: p.name,
    required,
    description: p.description || null,
    label: conv.label,
    statements: [`${rubyName} = ${fetch}`, ...conv.statements],
    isArray: false,
  };
}

// Turns "/pets/{petId}/ratings" into a Rails route pattern "/pets/:pet_id/ratings" - unlike
// ruby_faraday_client_generator's own buildPathExpr (a runtime string-interpolation Ruby
// expression, needing its literal segments escaped for embedding inside a Ruby string), this is a
// plain literal computed once at GENERATION time - toStringLiteral() (applied where this is used)
// handles embedding it safely, no manual escaping needed here. Uses the same rubyName the
// parameter's own extraction statements bind to (see buildPathParam) - Rails hands back whatever
// segment name the route pattern itself declares, so the two must agree.
function buildRailsPathPattern(pathStr, pathParams) {
  const byWireName = new Map(pathParams.map((p) => [p.wireName, p]));
  return (
    "/" +
    splitPathTemplate(pathStr)
      .map((seg) => {
        if ("param" in seg) {
          const p = byWireName.get(seg.param);
          if (!p) throw Error(`<c7e2a9f4> Path parameter "{${seg.param}}" in "${pathStr}" has no matching parameter definition`);
          return ":" + p.rubyName;
        }
        return seg.literal;
      })
      .join("/")
  );
}

const API_KEY_LOCATIONS = { header: ":header", query: ":query", cookie: ":cookie" };

// Resolves one security scheme name to { kind: "bearer" | "api_key", ... } - same scheme-type
// support (and same "no scope/claim validation" position) as
// ruby_faraday_client_generator's own buildAuthSchemeLiteral, just returning a plain JS object
// here instead of a Ruby hash literal, since the server side needs to generate EXTRACTION
// statements (see buildAuthParamForScheme below), not an `auth:` hash to pass to a request call.
function resolveSecurityScheme(schemeName) {
  const scheme = ((schema.components && schema.components.securitySchemes) || {})[schemeName];
  if (!scheme) throw Error(`<d9f3b6a1> security references scheme "${schemeName}", not declared in components.securitySchemes`);
  if ((scheme.type === "http" && String(scheme.scheme || "").toLowerCase() === "bearer") || scheme.type === "oauth2" || scheme.type === "openIdConnect") {
    return { kind: "bearer" };
  }
  if (scheme.type === "apiKey") {
    const loc = API_KEY_LOCATIONS[scheme.in];
    if (!loc) {
      throw Error(`<e1a6c8f2> apiKey security scheme "${schemeName}" has an unsupported location "in: ${scheme.in}" - only header, query, or cookie are supported`);
    }
    return { kind: "api_key", location: scheme.in, name: scheme.name };
  }
  throw Error(
    `<f4b2d9e6> Unsupported security scheme type "${scheme.type}" for "${schemeName}" - only http/bearer, apiKey, ` +
      `oauth2, and openIdConnect are currently supported`
  );
}

// Builds the extraction statement(s) for one security scheme, as an operation-level "parameter"
// (see buildAuthParams below) - `required` gates whether absence raises immediately
// (require_bearer_token/require_api_key) or is tolerated (bearer_token/api_key, nil-safe), the
// same "single alternative -> required; multiple OR alternatives -> each optional + a resolution
// check" split python_tornado_server_generator's own buildAuthParamForScheme uses.
function buildAuthSchemeParam(schemeName, required) {
  const scheme = resolveSecurityScheme(schemeName);
  const rubyName = paramName(schemeName);
  if (scheme.kind === "bearer") {
    const fetch = required ? "Runtime.require_bearer_token(request)" : "Runtime.bearer_token(request)";
    return { rubyName, required, label: "String", statements: [`${rubyName} = ${fetch}`] };
  }
  const loc = API_KEY_LOCATIONS[scheme.location];
  const nameLiteral = toStringLiteral(scheme.name);
  const fetch = required
    ? `Runtime.require_api_key(request, location: ${loc}, name: ${nameLiteral})`
    : `Runtime.api_key(request, location: ${loc}, name: ${nameLiteral})`;
  return { rubyName, required, label: "String", statements: [`${rubyName} = ${fetch}`] };
}

// Builds every security-scheme "parameter" an operation needs, plus (for 2+ OR alternatives) the
// trailing resolution check that raises MissingAuthenticationError unless at least one
// alternative's every scheme came back non-nil. A single alternative (security.length === 1)
// needs no resolution step at all - each of its schemes is individually required, so a missing
// one already raised during extraction. An empty alternative (`{}`, "anonymous access is also
// accepted" per the OpenAPI spec) makes the WHOLE operation authless, same as
// ruby_faraday_client_generator's own buildAuthLiteral.
function buildAuthParams(security) {
  if (!security || security.length === 0) return [];
  if (security.some((req) => Object.keys(req).length === 0)) return [];
  if (security.length === 1) {
    return Object.keys(security[0]).map((name) => buildAuthSchemeParam(name, true));
  }
  const uniqueNames = [...new Set(security.flatMap((req) => Object.keys(req)))];
  const schemeParams = uniqueNames.map((name) => buildAuthSchemeParam(name, false));
  const alternatives = security.map((req) => Object.keys(req).map((name) => paramName(name)));
  const conditions = alternatives.map((alt) => alt.map((rn) => `!${rn}.nil?`).join(" && "));
  const resolution = {
    rubyName: null,
    required: false,
    label: null,
    statements: [
      "auth_matched = false",
      ...conditions.map((cond) => `auth_matched ||= ${cond}`),
      'raise Runtime::MissingAuthenticationError, "no security requirement satisfied" unless auth_matched',
    ],
  };
  return [...schemeParams, resolution];
}

const JSON_MEDIA_TYPE = "application/json";
const MULTIPART_MEDIA_TYPE = "multipart/form-data";
const URLENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded";

function isTextMediaType(mediaType) {
  return mediaType.startsWith("text/");
}

// Ported near-verbatim from ruby_faraday_client_generator's own requireFlatObjectSchema - the
// SHAPE restriction on a multipart/urlencoded body is a wire-format fact (one property per form
// field), not a client-vs-server concern, so the policy is identical; only how the fields are
// actually READ differs (Rails parses both into `request.request_parameters` automatically - see
// runtime.rb#body_params - there's no equivalent to a client's own URI.encode_www_form call here).
function requireFlatObjectSchema(bodySchema, mediaType) {
  if (kindOf(bodySchema) !== "Object") {
    throw Error(`<a3d7e9c2> A "${mediaType}" body must be an object schema (one property per form field) - got ${kindOf(bodySchema)}`);
  }
  for (const [propName, propSchema] of Object.entries(bodySchema.properties || {})) {
    const resolved = unwrapSchema(propSchema);
    const kind = kindOf(resolved);
    if (kind === "Array") {
      const itemKind = kindOf(unwrapSchema(resolved.items || {}));
      if (itemKind !== "Primitive" && itemKind !== "Enum") {
        throw Error(
          `<b6f1d8a5> Unsupported "${mediaType}" body field "${propName}": array items must be primitive ` +
            `scalar types or enums - got ${itemKind}`
        );
      }
      continue;
    }
    if (kind !== "Primitive" && kind !== "Enum") {
      throw Error(
        `<c9e4f2a7> Unsupported "${mediaType}" body field "${propName}": only primitive scalar types ` +
          `(including format: binary strings), enums, or arrays of either are supported as form fields - got ${kind}`
      );
    }
  }
}

// A JSON request body needs no per-field type coercion - JSON.parse already hands back a real
// Integer/Float/true/false, so buildFromHExpr's identity passthrough for a "primitive" descriptor
// is correct as-is. multipart/form-data and application/x-www-form-urlencoded have NO such
// native typing at all - Rails' own request.request_parameters (see runtime.rb#body_params)
// hands back a plain String for every field regardless of the schema's declared type, exactly
// the same "everything arrives as a String" problem query/header/cookie parameters already have
// (see scalarConversionStatements) - a form field needs the identical coercion before <Model>.
// from_h ever sees it, or e.g. a `type: boolean` field stays the literal string "true"/"false"
// forever instead of becoming a real Ruby boolean. Mutates the raw wire Hash in place (each
// statement is `_body_raw["field"] = Runtime.parse_X(_body_raw["field"], "field")`)
// so <Model>.from_h(_body_raw) downstream still does everything else it normally does (wire-name
// mapping, defaults, nested enum/ref dispatch) unchanged - only scalar type coercion needed
// patching in ahead of it. Enum-typed fields are deliberately skipped here: a string enum's wire
// value is already the correct Ruby type (a String) and <EnumRef>.from_h validates membership
// itself - only a NUMERIC enum in a form field would need a coercion this doesn't perform (a rare
// enough shape to leave as a documented limitation rather than complicate this further). Array
// fields are skipped too - see this generator's README "Known limitations" for the analogous
// repeated-key caveat query arrays needed runtime.rb#query_array to solve, which multipart/
// urlencoded array fields don't currently have an equivalent for.
function buildFormFieldCoercions(registry, bodySchema) {
  const statements = [];
  for (const [propName, propSchema] of Object.entries(bodySchema.properties || {})) {
    const resolved = unwrapSchema(propSchema);
    if (kindOf(resolved) !== "Primitive") continue;
    const needsCoercion = resolved.type === "integer" || resolved.type === "number" || resolved.type === "boolean" || resolved.format === "date" || resolved.format === "date-time";
    if (!needsCoercion) continue;
    const wireLiteral = toStringLiteral(propName);
    const conv = scalarConversionStatements(registry, resolved, "", `_body_raw[${wireLiteral}]`, wireLiteral);
    statements.push(...conv.statements);
  }
  return statements;
}

// Ported near-verbatim from ruby_faraday_client_generator's own pickBodyContent - see that
// generator's README "Request body content types" for the full priority-order rationale.
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

// Builds the request body descriptor - `fetchExpr`/`decodeExpr` (added by the caller, see
// collectOperationsByTag) turn this into the actual extraction statement. json/multipart/
// urlencoded all read the same way on a Rails server (`request.request_parameters` parses all
// three automatically - see runtime.rb#body_params); only text/bytes need the raw body instead.
function buildRequestBody(registry, hintBase, requestBody) {
  if (!requestBody) return null;
  const content = requestBody.content || {};
  if (Object.keys(content).length === 0) return null;
  const picked = pickBodyContent(content);
  if (!picked) {
    throw Error(
      `<d2f6b9a3> Unsupported request body content-type(s) [${Object.keys(content).join(", ")}] - only ` +
        `"${JSON_MEDIA_TYPE}", "${MULTIPART_MEDIA_TYPE}", "${URLENCODED_MEDIA_TYPE}", a single "text/*" media ` +
        `type, or a single other media type (read as raw bytes) are supported`
    );
  }
  if (picked.encoding === "text" || picked.encoding === "bytes") {
    return { label: "String", descriptor: { kind: "primitive" }, required: requestBody.required === true, encoding: picked.encoding, mediaType: picked.mediaType };
  }
  const bodySchema = picked.content.schema || {};
  if (picked.encoding !== "json") requireFlatObjectSchema(bodySchema, picked.mediaType);
  const t = rubyType(registry, bodySchema, hintBase + "Body");
  const coercionStatements = picked.encoding !== "json" ? buildFormFieldCoercions(registry, bodySchema) : [];
  return { label: t.label, descriptor: t.descriptor, required: requestBody.required === true, encoding: picked.encoding, mediaType: null, coercionStatements };
}

// Ported near-verbatim from ruby_faraday_client_generator's own buildResponse, plus the numeric
// HTTP status code every generated action needs to actually respond with (that generator has no
// analogous need - a client only ever READS a status, never sends one).
function buildResponse(registry, hintBase, responses) {
  const picked = firstSuccessResponse(responses || {});
  const statusCode = picked ? (picked.statusCode === "default" ? 200 : parseInt(picked.statusCode, 10)) : 200;
  if (!picked) return { label: null, descriptor: null, encoding: "json", mediaType: null, statusCode };
  const content = picked.response.content || {};
  if (Object.keys(content).length === 0) return { label: null, descriptor: null, encoding: "json", mediaType: null, statusCode };
  const jsonContent = content[JSON_MEDIA_TYPE];
  if (jsonContent) {
    const t = rubyType(registry, jsonContent.schema || {}, hintBase + "Response");
    return { label: t.label, descriptor: t.descriptor, encoding: "json", mediaType: null, statusCode };
  }
  const remaining = Object.keys(content);
  if (remaining.length === 1) {
    const mediaType = remaining[0];
    return { label: "String", descriptor: { kind: "primitive" }, encoding: isTextMediaType(mediaType) ? "text" : "bytes", mediaType, statusCode };
  }
  throw Error(
    `<e5a8c2f9> Unsupported response content-type(s) [${remaining.join(", ")}] for the success response - only ` +
      `"${JSON_MEDIA_TYPE}", a single "text/*" media type, or a single other media type (as raw bytes) are ` +
      `supported`
  );
}

function tagDescription(tagName) {
  const tag = (schema.tags || []).find((t) => t.name === tagName);
  return (tag && tag.description) || null;
}

// Builds the YARD comment lines for one operation's handler-interface method - AGENTS.md's
// "thread OpenAPI description into generated doc comments" convention, covering summary AND
// description (both, not just summary), each documented parameter (as @param lines), and the
// return type (as @return - RubyMine and other YARD-aware tools use this to type-check a
// handler's implementation against what the generated code will actually call it with).
function buildDocLines(op, docParams, response) {
  const lines = [];
  if (op.summary) lines.push(op.summary);
  if (op.description) lines.push(op.description);
  for (const p of docParams) lines.push(p.description ? `@param ${p.name} [${p.label}] ${p.description}` : `@param ${p.name} [${p.label}]`);
  lines.push(response.descriptor ? `@return [${response.label}]` : "@return [void]");
  return lines;
}

// Returns a Map<tag, { tagModule, fileBase, description, operations: [...] }> in
// path-declaration order. Every operation's statements (params, auth, body) are precomputed as
// flat Ruby statement lists (see this file's header comment) - controller.rb.j2 just concatenates
// them in order, then calls the handler and renders the response.
export function collectOperationsByTag(registry) {
  const groups = new Map();
  for (const op of collectOperations()) {
    withResilience(
      `operation ${op.method.toUpperCase()} ${op.path}`,
      () => {
        const tag = (op.tags && op.tags[0]) || "Default";
        const tagBase = className(tag);
        const fileBase = toSnakeCase(tagBase);
        const opName = operationName(op.method, op.path, op.operationId);
        const hintBase = tagBase + className(opName);

        const allParams = op.parameters || [];
        const pathParams = allParams.filter((p) => p.in === "path").map((p) => buildPathParam(registry, hintBase, p));
        const queryParams = allParams.filter((p) => p.in === "query").map((p) => buildQueryParam(registry, hintBase, p));
        const headerParams = allParams.filter((p) => p.in === "header").map((p) => buildHeaderParam(registry, hintBase, p));
        const cookieParams = allParams.filter((p) => p.in === "cookie").map((p) => buildCookieParam(registry, hintBase, p));

        let authParams = [];
        withResilience(
          `security for operation ${op.method.toUpperCase()} ${op.path}`,
          () => {
            authParams = buildAuthParams(op.security);
          },
          () => {
            authParams = [];
          }
        );

        const body = buildRequestBody(registry, hintBase, op.requestBody);
        const response = buildResponse(registry, hintBase, op.responses);
        const routePattern = buildRailsPathPattern(op.path, pathParams);

        // Every extraction statement, in the order the generated action body prints them: path,
        // then query/header/cookie (order doesn't matter among these three), then auth, then body.
        const allParamGroups = [...pathParams, ...queryParams, ...headerParams, ...cookieParams, ...authParams];
        const statements = allParamGroups.flatMap((p) => p.statements);

        let bodyStatements = null;
        if (body) {
          if (body.encoding === "text" || body.encoding === "bytes") {
            bodyStatements = ["body = request.raw_post"];
          } else {
            // multipart/urlencoded fields need per-field string coercion BEFORE from_h (see
            // buildFormFieldCoercions) - json doesn't (coercionStatements is empty there).
            bodyStatements = [
              "_body_raw = Runtime.body_params(request)",
              ...body.coercionStatements,
              `body = ${body.label}.from_h(_body_raw)`,
              "body&.validate!",
            ];
          }
        }

        // The handler-interface method's own keyword-argument list - every real parameter (not
        // the synthetic auth-resolution entry, which has no rubyName/value of its own) plus `body:`
        // last, if the operation has one.
        const handlerKwargs = [...pathParams, ...queryParams, ...headerParams, ...cookieParams, ...authParams.filter((p) => p.rubyName)].map((p) => ({
          rubyName: p.rubyName,
          required: p.required,
        }));
        if (body) handlerKwargs.push({ rubyName: "body", required: body.required });

        // A multipart body's `format: binary` field(s) pass through untouched (see
        // requireFlatObjectSchema above) - the operation's own doc comment is the only place that
        // can hint what an incoming value there actually is (an ActionDispatch::Http::UploadedFile).
        let description = op.description || null;
        if (body && body.encoding === "multipart") {
          const hint = "For multipart/form-data: a `format: binary` field arrives as an ActionDispatch::Http::UploadedFile.";
          description = description ? `${description} ${hint}` : hint;
        }

        const docParams = [...pathParams, ...queryParams, ...headerParams, ...cookieParams, ...authParams.filter((p) => p.rubyName)]
          .filter((p) => p.description || p.label)
          .map((p) => ({ name: p.rubyName, label: p.label, description: p.description }));
        if (body) docParams.push({ name: "body", label: body.label, description: null });

        if (!groups.has(tag)) groups.set(tag, { tagBase, fileBase, description: tagDescription(tag), operations: [] });
        groups.get(tag).operations.push({
          name: opName,
          httpMethod: op.method.toLowerCase(),
          routePattern,
          docLines: buildDocLines({ summary: op.summary, description }, docParams, response),
          handlerKwargs,
          statements,
          bodyStatements,
          body,
          response,
          responseWireExpr: response.descriptor ? buildToWireExpr(response.descriptor, "result") : null,
        });
      },
      () => {} // permissive mode: drop this operation, keep the rest of the group as-is
    );
  }
  return groups;
}
