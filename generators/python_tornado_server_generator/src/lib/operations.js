// Groups the engine's already-merged/deref'd collectOperations() by tag, then by path (Tornado
// dispatches a URL pattern to ONE RequestHandler class, which implements one method per HTTP verb
// - unlike Ktor's per-operation route DSL, so grouping by path, not just by tag, is what this
// generator's api_module.py.j2 needs - see README), and builds a fully precomputed description of
// each operation - including the handler ABC method's full signature, the RequestHandler method's
// full body as a flat list of Python statement lines, and the route-building call - so
// api_module.py.j2 stays a near-mechanical printer instead of re-deriving logic in Inja (which has
// no ternary operator - see docs/templating.md - so any "required vs optional" branching is much
// easier to get right here in JS than in the template). Mirrors
// kotlin_ktor_server_generator/src/lib/operations.js's own role.
//
// Everything here runs before any renderTemplate call (see main.js), while schema/parameter/
// response objects still have real JS identity - kindOf/constraintsOf/nameOf/firstSuccessResponse/
// unwrapSchema only work up to that point (see docs/javascript-api.md's "renderTemplate" section).

import { className, fieldName, moduleName, operationName } from "./naming.js";
import { escapePythonString } from "./keywords.js";
import { pyType } from "./types.js";
import { buildFromWireExpr, buildToWireExpr, buildValidateStatements } from "./serialization.js";
import { withResilience } from "./strict.js";

const JSON_MEDIA_TYPE = "application/json";

function isTextMediaType(mediaType) {
  return mediaType.startsWith("text/");
}

// Prefixes every line of a (possibly multi-line, from a nested array/record validate() block - see
// lib/serialization.js) statement string with `prefix`, preserving relative indentation.
function indentLines(lines, prefix) {
  return lines.map((line) =>
    line
      .split("\n")
      .map((l) => prefix + l)
      .join("\n")
  );
}

// A path/query/header parameter (and a query-array's own item type) resolves to a primitive
// scalar type or an enum - anything else is a generator error. Returns { pyType, parseCall } where
// parseCall(expr), if non-null, builds the full "parse and validate" call expression for a raw
// string; null means the raw string itself is already the right Python type (str). `fieldLabel` is
// only used for a primitive's own error message (an enum's from_wire names itself already).
function scalarParamType(registry, t, fieldLabel) {
  if (t.descriptor.kind === "primitive") {
    const fns = { int: "runtime.parse_int", float: "runtime.parse_float", bool: "runtime.parse_bool" };
    const fn = fns[t.descriptor.pyType];
    return { pyType: t.descriptor.pyType, parseCall: fn ? (expr) => `${fn}(${expr}, ${escapePythonString(fieldLabel)})` : null };
  }
  if (t.descriptor.kind === "ref") {
    const model = registry.models.get(t.descriptor.refName);
    if (model && model.kind === "enum") return { pyType: t.label, parseCall: (expr) => `${t.label}.from_wire(${expr})` };
  }
  return null;
}

// Builds one path/query/header parameter's extraction+validation as a flat list of standalone
// Python statement lines. `setupLines` is empty for a path parameter - Tornado's own routing
// already binds it as a same-named method argument (see buildUrlPattern) - except for a
// non-string path parameter's own type conversion/validation, which still needs generating. A
// query parameter's (unwrapped) schema may also be Array-kind, serialized as repeated
// `?name=a&name=b` keys (OpenAPI 3's default `style: form, explode: true`) - path/header stay
// scalar-only, matching every sibling generator.
function buildParam(registry, hintBase, p) {
  const schema = p.schema || { type: "string" };
  const resolved = unwrapSchema(schema);
  const pyName = fieldName(p.name);
  const isPath = p.in === "path";
  const required = isPath || !!p.required;

  if (p.in === "query" && kindOf(resolved) === "Array") {
    const itemT = pyType(registry, resolved.items || { type: "string" }, hintBase + className(p.name) + "Item");
    const item = scalarParamType(registry, itemT, p.name);
    if (!item) {
      throw Error(
        `<01534acc> Unsupported query parameter array item type for "${p.name}": array items must be ` +
          `primitive scalar types (string/integer/number/boolean) or enums, got "${itemT.label}"`
      );
    }
    const rawVar = pyName + "_raw";
    const lines = [`${rawVar} = self.get_query_arguments(${escapePythonString(p.name)})`];
    if (required) lines.push(`if not ${rawVar}: raise ValidationError('"${p.name}" is required')`);
    lines.push(item.parseCall ? `${pyName} = [${item.parseCall("_item")} for _item in ${rawVar}]` : `${pyName} = ${rawVar}`);
    return {
      pyName,
      wireName: p.name,
      in: p.in,
      typeAnnotation: `List[${item.pyType}]`,
      required,
      isPath: false,
      setupLines: lines,
      description: p.description || null,
    };
  }

  const t = pyType(registry, schema, hintBase + className(p.name));
  const item = scalarParamType(registry, t, p.name);
  if (!item) {
    throw Error(
      `<b6f1a4c3> Unsupported parameter type for "${p.name}" (in: ${p.in}): only primitive scalar types ` +
        `(string/integer/number/boolean) or enums are supported in path/query/header position, got "${t.label}"`
    );
  }
  const lines = [];
  const rawVar = pyName + "_raw";
  if (isPath) {
    // Tornado always binds a named path-capture group as plain str (see buildUrlPattern, which
    // names the group "{pyName}_raw" to match) - converting into a fresh `pyName` local (rather
    // than reassigning the bound "{pyName}_raw" parameter itself) avoids a mypy --strict
    // "incompatible types in assignment" for any parameter whose final type isn't also str.
    lines.push(item.parseCall ? `${pyName} = ${item.parseCall(rawVar)}` : `${pyName} = ${rawVar}`);
  } else {
    if (p.in === "header") lines.push(`${rawVar} = self.request.headers.get(${escapePythonString(p.name)})`);
    else lines.push(`${rawVar} = self.get_query_argument(${escapePythonString(p.name)}, default=None)`);
    if (required) lines.push(`if ${rawVar} is None: raise ValidationError('"${p.name}" is required')`);
    lines.push(
      item.parseCall ? `${pyName} = ${item.parseCall(rawVar)} if ${rawVar} is not None else None` : `${pyName} = ${rawVar}`
    );
  }
  lines.push(...buildValidateStatements(t.descriptor, schema, pyName, p.name));
  return {
    pyName,
    wireName: p.name,
    in: p.in,
    typeAnnotation: required ? item.pyType : `Optional[${item.pyType}]`,
    // Tornado always binds a named path-capture group as a plain str, regardless of this
    // parameter's own final (possibly converted) type - only meaningful for isPath params, used by
    // the concrete Tornado method's own signature (see pathMethodSignature below), never by the
    // abstract handler interface's signature (op.signature), which reflects the type *after*
    // setupLines above has already converted it.
    rawTypeAnnotation: "str",
    required,
    isPath,
    setupLines: lines,
    description: p.description || null,
  };
}

const MULTIPART_MEDIA_TYPE = "multipart/form-data";
const URLENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded";

function pickBodyContent(content) {
  if (content[JSON_MEDIA_TYPE]) return { mediaType: JSON_MEDIA_TYPE, content: content[JSON_MEDIA_TYPE], encoding: "json" };
  // Tornado parses either into the same self.request.body_arguments/get_body_argument() API - one
  // generated code path covers both encodings, same unification Go's r.FormValue gives that
  // generator's server.
  if (content[MULTIPART_MEDIA_TYPE]) return { mediaType: MULTIPART_MEDIA_TYPE, content: content[MULTIPART_MEDIA_TYPE], encoding: "form" };
  if (content[URLENCODED_MEDIA_TYPE]) return { mediaType: URLENCODED_MEDIA_TYPE, content: content[URLENCODED_MEDIA_TYPE], encoding: "form" };
  const remaining = Object.keys(content);
  if (remaining.length === 1) {
    const mediaType = remaining[0];
    return { mediaType, content: content[mediaType], encoding: isTextMediaType(mediaType) ? "text" : "bytes" };
  }
  return null;
}

// application/x-www-form-urlencoded and multipart/form-data bodies are, by OpenAPI convention,
// always `type: object` schemas with one property per form field. Anything else (a nested
// object/array property) is a generator error - same "handle the common case, error on the rest"
// policy path/header params already follow.
function requireFlatObjectSchema(bodySchema, mediaType) {
  if (kindOf(bodySchema) !== "Object") {
    throw Error(`<c7e2a915> A "${mediaType}" body must be an object schema (one property per form field) - got ${kindOf(bodySchema)}`);
  }
  for (const [propName, propSchema] of Object.entries(bodySchema.properties || {})) {
    const kind = kindOf(unwrapSchema(propSchema));
    if (kind !== "Primitive" && kind !== "Enum") {
      throw Error(
        `<f31b0d6a> Unsupported "${mediaType}" body field "${propName}": only primitive scalar types or enums ` +
          `are supported as form fields - got ${kind}`
      );
    }
  }
}

// Request bodies support application/json (parsed via json.loads then the schema's own
// from_wire/validate), multipart/form-data and application/x-www-form-urlencoded (a flat object
// schema only, built field-by-field then validated as a whole via the constructed object's own
// validate() - see requireFlatObjectSchema), a single "text/*" media type (received as str), and a
// single other media type (received as raw bytes). A requestBody declaring 2+ remaining media
// types outside these is a generator error, never silently guessed.
function buildRequestBody(registry, hintBase, requestBody) {
  if (!requestBody) return null;
  const content = requestBody.content || {};
  if (Object.keys(content).length === 0) return null;
  const picked = pickBodyContent(content);
  if (!picked) {
    throw Error(
      `<9d3b7e2a> Unsupported request body content-type(s) [${Object.keys(content).join(", ")}] - only ` +
        `"${JSON_MEDIA_TYPE}", "${MULTIPART_MEDIA_TYPE}", "${URLENCODED_MEDIA_TYPE}", a single "text/*" media ` +
        `type (as str), or a single other media type (as raw bytes) are supported`
    );
  }
  const required = requestBody.required === true;

  const setupLines = [];
  let type;
  if (picked.encoding === "json") {
    const bodySchema = picked.content.schema || {};
    const t = pyType(registry, bodySchema, hintBase + "Body");
    type = t.label;
    setupLines.push(`_body_raw = self.request.body`);
    if (required) setupLines.push(`if not _body_raw: raise ValidationError("request body is required")`);
    setupLines.push(`_body_data = json.loads(_body_raw) if _body_raw else None`);
    setupLines.push(`body = ${buildFromWireExpr(t.descriptor, "_body_data")}`);
    if (required) setupLines.push(`if body is None: raise ValidationError("request body is required")`);
    setupLines.push(...buildValidateStatements(t.descriptor, bodySchema, "body", "body"));
  } else if (picked.encoding === "form") {
    const bodySchema = picked.content.schema || {};
    requireFlatObjectSchema(bodySchema, picked.mediaType);
    const t = pyType(registry, bodySchema, hintBase + "Body");
    type = t.label;
    const model = registry.models.get(t.label);
    for (const p of model.properties) {
      const item = scalarParamType(registry, { label: p.label, descriptor: p.descriptor }, p.wireName);
      const rawVar = `_${p.pyName}_raw`;
      setupLines.push(`${rawVar} = self.get_body_argument(${p.wireLiteral}, default=None)`);
      setupLines.push(
        item.parseCall ? `_${p.pyName} = ${item.parseCall(rawVar)} if ${rawVar} is not None else None` : `_${p.pyName} = ${rawVar}`
      );
    }
    // Each raw extraction above is typed Optional (get_body_argument/parseCall's from_wire both
    // always allow None) - correctly so for an optional field, but a required field's constructor
    // slot is the bare (non-Optional) type, so cast() narrows it there, trusting the body.validate()
    // call right after to actually enforce required-ness/constraints (same "cast now, validate
    // immediately after" contract lib/types.js's buildFromWireExprTyped uses for a JSON body's own
    // from_wire construction). Casting an already-optional field would be a no-op mypy --strict
    // flags as redundant, so this only wraps the required ones.
    const ctorLines = model.properties
      .map((p) => (p.optional ? `    ${p.pyName}=_${p.pyName},` : `    ${p.pyName}=cast(${p.label}, _${p.pyName}),`))
      .join("\n");
    setupLines.push(`body = ${t.label}(\n${ctorLines}\n)`);
    // Individual fields above are only converted to their Python type, not constraint-checked -
    // the constructed object's own validate() (required-ness plus every declared constraint)
    // covers that in one call, same as the json encoding's whole-body validate() above.
    setupLines.push(`body.validate()`);
  } else if (picked.encoding === "text") {
    type = "str";
    setupLines.push(`body = self.request.body.decode("utf-8")`);
  } else {
    type = "bytes";
    setupLines.push(`body = self.request.body`);
  }
  // A "form" body is always constructed (never None) regardless of the schema's own `required` -
  // there's no single "body is present" signal for form data the way JSON's raw bytes give one, so
  // the handler signature always gets a plain (non-Optional) body parameter for this encoding.
  return { type, encoding: picked.encoding, required: picked.encoding === "form" ? true : required, mediaType: picked.mediaType, setupLines };
}

// A success response's content type follows the same content-type-driven policy as request bodies
// (see buildRequestBody) - application/json gets a real generated type, a single "text/*" media
// type maps to str, a single other media type maps to raw bytes; no content: means an empty body.
function buildResponse(registry, hintBase, responses) {
  const picked = firstSuccessResponse(responses || {});
  if (!picked) return { type: "None", statusCode: 200, encoding: "none", mediaType: null };
  const statusCode = /^\d+$/.test(picked.statusCode) ? parseInt(picked.statusCode, 10) : 200;
  const content = picked.response.content || {};
  if (Object.keys(content).length === 0) return { type: "None", statusCode, encoding: "none", mediaType: null };
  const jsonContent = content[JSON_MEDIA_TYPE];
  if (jsonContent) {
    const t = pyType(registry, jsonContent.schema || {}, hintBase + "Response");
    return { type: t.label, statusCode, encoding: "json", mediaType: JSON_MEDIA_TYPE, toWireExpr: buildToWireExpr(t.descriptor, "result") };
  }
  const remaining = Object.keys(content);
  if (remaining.length === 1) {
    const mediaType = remaining[0];
    const encoding = isTextMediaType(mediaType) ? "text" : "bytes";
    return { type: encoding === "text" ? "str" : "bytes", statusCode, encoding, mediaType };
  }
  throw Error(
    `<e2f7c8a1> Unsupported response content-type(s) [${remaining.join(", ")}] for the success response - only ` +
      `"${JSON_MEDIA_TYPE}", a single "text/*" media type, or a single other media type (as raw bytes) are supported`
  );
}

function buildDocstring(summary, description, params) {
  const lines = [];
  if (summary) lines.push(summary);
  if (description && description !== summary) {
    if (lines.length) lines.push("");
    lines.push(description);
  }
  const paramLines = params.filter((p) => p.description).map((p) => `:param ${p.pyName}: ${p.description}`);
  if (paramLines.length) {
    if (lines.length) lines.push("");
    lines.push(...paramLines);
  }
  return lines.length ? lines.join("\n") : null;
}

// Converts an OpenAPI path template into a Tornado URL-pattern regex with named capture groups,
// using the engine's splitPathTemplate() (docs/javascript-api.md) instead of hand-rolling the same
// "/"-split + `{param}` regex every path-based generator otherwise needs.
function buildUrlPattern(pathStr) {
  const segments = splitPathTemplate(pathStr);
  if (segments.length === 0) return "/";
  let pattern = "";
  for (const seg of segments) {
    if ("literal" in seg) pattern += "/" + seg.literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The capture group name ends in "_raw" to match the concrete Tornado method's own parameter
    // name (see buildParam/pathSigParts) - the plain (unsuffixed) name is reserved for the
    // *converted* local each operation method builds from it.
    else pattern += "/(?P<" + fieldName(seg.param) + "_raw>[^/]+)";
  }
  return pattern;
}

// Derives a name for the generated RequestHandler class from a path's own literal/param segments
// (operations sharing one path are grouped onto one class - see this file's header comment - so an
// operation-derived name wouldn't fit every method on the class equally well).
function pathHandlerName(pathStr) {
  const segments = splitPathTemplate(pathStr);
  const literalParts = segments.filter((s) => "literal" in s).map((s) => s.literal);
  const paramParts = segments.filter((s) => "param" in s).map((s) => s.param);
  let hint = literalParts.join(" ") || "root";
  if (paramParts.length > 0) hint += " by " + paramParts.join(" and ");
  return "_" + className(hint) + "Handler";
}

// Only `http`/`bearer` and `apiKey` security schemes are supported - same restriction every
// sibling generator's own auth codegen has. Returns a param-shaped object (pyName/typeAnnotation/
// setupLines/description) that slots directly into the same otherParams list a path/query/header
// parameter does (see buildAuthParams below), reusing buildSignatures/buildMethodBodyLines/
// buildDocstring unchanged.
function buildAuthParamForScheme(schemeName, scheme) {
  const isBearer = scheme.type === "http" && (scheme.scheme || "").toLowerCase() === "bearer";
  const pyName = fieldName(schemeName + (isBearer ? "_token" : "_key"));
  if (isBearer) {
    return {
      pyName,
      wireName: null,
      in: null,
      typeAnnotation: "str",
      required: true,
      isPath: false,
      description: null,
      setupLines: [
        `${pyName}_raw = self.request.headers.get("Authorization")`,
        `if ${pyName}_raw is None: raise MissingAuthenticationError('missing required "Authorization" header')`,
        `${pyName} = ${pyName}_raw[7:] if ${pyName}_raw.lower().startswith("bearer ") else ${pyName}_raw`,
      ],
    };
  }
  if (scheme.type === "apiKey") {
    let getExpr;
    if (scheme.in === "header") getExpr = `self.request.headers.get(${escapePythonString(scheme.name)})`;
    else if (scheme.in === "query") getExpr = `self.get_query_argument(${escapePythonString(scheme.name)}, default=None)`;
    else if (scheme.in === "cookie") getExpr = `self.get_cookie(${escapePythonString(scheme.name)})`;
    else throw Error(`<9b6a1e3f> Unsupported apiKey location "${scheme.in}" for security scheme "${schemeName}"`);
    return {
      pyName,
      wireName: null,
      in: null,
      typeAnnotation: "str",
      required: true,
      isPath: false,
      description: null,
      setupLines: [
        `${pyName} = ${getExpr}`,
        `if ${pyName} is None: raise MissingAuthenticationError('missing required apiKey {} (in: {})'.format(` +
          `${escapePythonString(scheme.name)}, ${escapePythonString(scheme.in)}))`,
      ],
    };
  }
  throw Error(
    `<9b6a1e3f> Unsupported security scheme type "${scheme.type}" for "${schemeName}" - only "http" (bearer) and "apiKey" schemes are supported`
  );
}

// A security requirement with 2+ alternatives (OR) has no single combination of handler parameters
// that covers every alternative, so it's unsupported (same restriction every sibling generator's
// own auth codegen applies) - one AND-combination (every scheme in a single requirement entry) is
// fine.
function buildAuthParams(security) {
  if (!security || security.length === 0) return [];
  if (security.length > 1) {
    throw Error(`<c4d8f271> Unsupported security requirement: multiple alternative (OR) security requirements are not supported`);
  }
  const schemes = (schema.components && schema.components.securitySchemes) || {};
  return Object.keys(security[0]).map((schemeName) => buildAuthParamForScheme(schemeName, schemes[schemeName] || {}));
}

function tagDescription(tagName) {
  const tag = (schema.tags || []).find((t) => t.name === tagName);
  return (tag && tag.description) || null;
}

// Builds the handler ABC method's full parameter list (everything after `self`, keyword-only -
// Python's keyword-only arguments may freely mix required/optional in any order, unlike positional
// ones, so no "required must precede optional" reordering is needed here) and the matching call
// site's keyword arguments string, shared between the abstract method declaration and the
// RequestHandler method that calls it.
function buildSignatures(pathParams, otherParams, body) {
  const allParams = [...pathParams, ...otherParams];
  const sigParts = allParams.map((p) => `${p.pyName}: ${p.typeAnnotation}`);
  const callParts = allParams.map((p) => `${p.pyName}=${p.pyName}`);
  if (body) {
    sigParts.push(body.required ? `body: ${body.type}` : `body: Optional[${body.type}] = None`);
    callParts.push(`body=body`);
  }
  return {
    signature: sigParts.length > 0 ? `self, *, ${sigParts.join(", ")}` : "self",
    callArgs: callParts.join(", "),
  };
}

// Builds the generated RequestHandler method's full body as a flat list of Python statement lines
// (each independently placed by the template via Inja's indent() filter - see
// lib/serialization.js's header comment for why this "generate structurally, let indent() align
// it" split is used throughout this generator).
function buildMethodBodyLines(op, pathParams) {
  const inner = [];
  // A path parameter is already bound as a same-named method argument by Tornado's own routing
  // (see buildUrlPattern) - but its own type conversion/validation (e.g. a non-string type, or any
  // declared constraint) still needs to run somewhere, and every operation on this path gets its
  // own copy of these lines (Tornado calls get()/post()/etc. directly per request - there's no
  // single shared "convert path params once" hook to route through instead).
  for (const p of pathParams) inner.push(...p.setupLines);
  for (const p of op.otherParams) inner.push(...p.setupLines);
  if (op.body) inner.push(...op.body.setupLines);
  inner.push(op.returnsValue ? `result = ${op.callExpr}` : op.callExpr);

  const lines = [
    `try:`,
    ...indentLines(inner, "    "),
    `except MissingAuthenticationError as exc:`,
    `    raise HTTPError(401, reason=str(exc))`,
    `except ValidationError as exc:`,
    `    raise HTTPError(422, reason=str(exc))`,
  ];

  if (op.response.statusCode !== 200) lines.push(`self.set_status(${op.response.statusCode})`);
  if (op.response.encoding === "json") {
    lines.push(`self.set_header("Content-Type", "application/json")`);
    lines.push(`self.write(json.dumps(${op.response.toWireExpr}))`);
  } else if (op.response.encoding === "text" || op.response.encoding === "bytes") {
    lines.push(`self.set_header("Content-Type", ${escapePythonString(op.response.mediaType)})`);
    lines.push(`self.write(result)`);
  }
  return lines;
}

// Returns a Map<tag, { tagClass, tagModule, description, paths: [{ pathStr, urlPattern,
// handlerClass, pathParams, pathSignature, operations: [...] }] }> in path-declaration order.
export function collectOperationsByPathAndTag(registry) {
  const tags = new Map();

  for (const op of collectOperations()) {
    // tornado.web.RequestHandler.SUPPORTED_METHODS has no TRACE - same reason
    // kotlin_ktor_server_generator excludes it (Ktor's routing DSL has no Route.trace() either).
    if (op.method === "trace") continue;

    withResilience(
      `operation ${op.method.toUpperCase()} ${op.path}`,
      () => {
        const tagName = (op.tags && op.tags[0]) || "Default";
        const tagClass = className(tagName) + "Handler";
        const tagModule = moduleName(tagName);
        const opName = operationName(op.method, op.path, op.operationId);
        const hintBase = className(tagName) + className(opName);

        const allParams = op.parameters.map((p) => buildParam(registry, hintBase, p));
        const pathParams = allParams.filter((p) => p.isPath);
        const otherParams = [...buildAuthParams(op.security), ...allParams.filter((p) => !p.isPath)];

        const body = buildRequestBody(registry, hintBase, op.requestBody);
        const response = buildResponse(registry, hintBase, op.responses);
        const { signature, callArgs } = buildSignatures(pathParams, otherParams, body);

        const docstring = buildDocstring(
          op.summary,
          op.description,
          [...pathParams, ...otherParams].filter((p) => p.description).map((p) => ({ pyName: p.pyName, description: p.description }))
        );

        if (!tags.has(tagName)) tags.set(tagName, { tagClass, tagModule, description: tagDescription(tagName), paths: new Map() });
        const tagGroup = tags.get(tagName);
        if (!tagGroup.paths.has(op.path)) {
          const pathSigParts = pathParams.map((p) => `${p.pyName}_raw: ${p.rawTypeAnnotation}`);
          tagGroup.paths.set(op.path, {
            pathStr: op.path,
            urlPattern: buildUrlPattern(op.path),
            handlerClass: pathHandlerName(op.path),
            pathParams,
            pathMethodSignature: pathSigParts.length > 0 ? `self, ${pathSigParts.join(", ")}` : "self",
            operations: [],
          });
        }
        const operation = {
          name: opName,
          httpMethod: op.method,
          docstring,
          signature,
          callExpr: `self._handler.${opName}(${callArgs})`,
          otherParams,
          body,
          response,
          returnsValue: response.type !== "None",
        };
        operation.bodyLines = buildMethodBodyLines(operation, pathParams);
        tagGroup.paths.get(op.path).operations.push(operation);
      },
      () => {} // permissive mode: drop this operation, keep the rest of the group as-is
    );
  }

  const result = new Map();
  for (const [tagName, group] of tags) {
    result.set(tagName, { ...group, paths: Array.from(group.paths.values()) });
  }
  return result;
}
