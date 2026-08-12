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
import { escapeKotlinStringContent } from "./keywords.js";
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
  // mapping), so it needs no special handling in convertOrThrow's catch clause.
  "kotlinx.datetime.LocalDate": "kotlinx.datetime.LocalDate.parse(it)",
  "kotlinx.datetime.Instant": "kotlinx.datetime.Instant.parse(it)",
};

// Unwraps a schema through any chain of single-branch oneOf/anyOf/allOf wrappers (see ktType's
// identical handling in types.js) down to the schema that actually determines its wire shape -
// e.g. `allOf: [$ref EnumSchema]` (a common .NET/Swashbuckle idiom for attaching a description
// next to a $ref) unwraps to EnumSchema itself. kindOf() only looks at the schema handed to it,
// not through composition wrappers, so anything inspecting a param's actual shape (as opposed to
// just its Kotlin type name, which ktType already resolves correctly on its own) needs this.
function unwrapSingleBranch(schema) {
  let s = schema;
  for (;;) {
    const kind = kindOf(s);
    if ((kind === "OneOf" || kind === "AnyOf") && (s.oneOf || s.anyOf || []).length === 1) {
      s = (s.oneOf || s.anyOf)[0];
      continue;
    }
    if (kind === "AllOf" && s.allOf.length === 1) {
      s = s.allOf[0];
      continue;
    }
    return s;
  }
}

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

// A query param whose (unwrapped) schema is Array-kind - serialized as repeated `?name=a&name=b`
// keys (OpenAPI 3's default `style: form, explode: true`), matching the typescript_fetch_client
// generator's own support for this (path/header positions have no standard "repeated value"
// serialization, so those stay scalar-only). `converter`/`typeLabel` describe the ITEM type, not
// the `List<...>` as a whole - queryParamListAs/requireQueryParamListAs (unused on the client
// side, kept for structural parity with the server generator) apply it per element.
function buildArrayQueryParam(registry, hintBase, p, itemSchema) {
  const itemT = ktType(registry, itemSchema, hintBase + className(p.name) + "Item");
  const itemConverter =
    kindOf(unwrapSingleBranch(itemSchema)) === "Enum" ? `${itemT.type}.fromWireValue(it)` : PARAM_CONVERTERS[itemT.type];
  if (!itemConverter) {
    throw Error(
      `<f1a2b3c4> Unsupported query parameter array item type for "${p.name}": array items must be ` +
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
    converter: itemConverter,
    extractFn: required ? "requireQueryParamListAs" : "queryParamListAs",
    validationCalls: [],
    description: p.description || null,
  };
}

function buildParam(registry, hintBase, p) {
  const schema = p.schema || { type: "string" };
  const resolved = unwrapSingleBranch(schema);
  if (p.in === "query" && kindOf(resolved) === "Array") {
    return buildArrayQueryParam(registry, hintBase, p, resolved.items || { type: "string" });
  }
  const t = isPrimitiveLikeUnion(resolved) ? { type: "String" } : ktType(registry, schema, hintBase + className(p.name));
  // An enum-typed param parses/prints via the enum's own wireValue/fromWireValue (see
  // model_enum.kt.j2) rather than a fixed PARAM_CONVERTERS entry, since the conversion snippet
  // needs the enum's own class name embedded in it.
  const converter = kindOf(resolved) === "Enum" ? `${t.type}.fromWireValue(it)` : PARAM_CONVERTERS[t.type];
  if (!converter) {
    throw Error(
      `<e9faabbc> Unsupported parameter type for "${p.name}" (in: ${p.in}): only primitive scalar ` +
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
    converter,
    extractFn,
    validationCalls: buildValidationCalls(kotlinName, p.name, t.type, constraints),
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

// `required` correctly defaults to OpenAPI 3.0's actual default (`false` when absent) - the
// engine's requestBody.required has no "true unless explicitly false" special case.
function buildRequestBody(registry, hintBase, requestBody) {
  if (!requestBody) return null;
  const jsonContent = (requestBody.content || {})["application/json"];
  if (!jsonContent) return null;
  const t = ktType(registry, jsonContent.schema || {}, hintBase + "Body");
  const model = registry.models.get(t.type);
  return { type: t.type, required: requestBody.required === true, hasValidate: !!model && model.kind === "object" };
}

// Uses the engine's firstSuccessResponse() (see docs/javascript-api.md) instead of hand-rolling
// the same "first declared 2xx, else default" pick every response-handling generator otherwise
// needs.
function buildResponse(registry, hintBase, responses) {
  const picked = firstSuccessResponse(responses || {});
  if (!picked) return { type: "Unit", statusCode: 200 };
  const statusCode = /^\d+$/.test(picked.statusCode) ? parseInt(picked.statusCode, 10) : 200;
  const content = (picked.response.content || {})["application/json"];
  if (!content) return { type: "Unit", statusCode };
  const t = ktType(registry, content.schema || {}, hintBase + "Response");
  return { type: t.type, statusCode };
}

// Builds the lines of a KDoc comment from a summary, a longer description, and a list of
// {name, description} @param entries - or [] if there's nothing to say (Inja's {% for %} throws
// on null/undefined rather than treating it as zero iterations, so this must never be nullish).
// Each line is ready to print verbatim (already has "/**"/" * "/" */" as needed); callers prepend
// their own call site's indentation per line (method body vs. interface vs. routing block - see
// the templates).
function buildDocLines(summary, description, params) {
  const paramLines = (params || []).filter((p) => p.description).map((p) => `@param ${p.name} ${p.description}`);
  const bodyLines = [summary, description].filter(Boolean);
  const lines = [...bodyLines];
  if (paramLines.length) {
    if (lines.length) lines.push("");
    lines.push(...paramLines);
  }
  if (lines.length === 0) return [];
  if (lines.length === 1) return [`/** ${lines[0]} */`];
  return ["/**", ...lines.map((l) => (l ? ` * ${l}` : " *")), " */"];
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
          docLines: buildDocLines(
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
