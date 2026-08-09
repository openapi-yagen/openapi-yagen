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
};

function buildParam(registry, hintBase, p) {
  const t = ktType(registry, p.schema || { type: "string" }, hintBase + className(p.name));
  const converter = PARAM_CONVERTERS[t.type];
  if (!converter) {
    throw Error(
      `<e9faabbc> Unsupported parameter type for "${p.name}" (in: ${p.in}): only primitive scalar ` +
        `types (string/integer/number/boolean) are supported for path/query/header parameters, got "${t.type}"`
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
    nullable: !required,
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
    throw Error(`<a1b2c3d4> security references scheme "${schemeName}", not declared in components.securitySchemes`);
  }
  const { kotlinName } = fieldName(schemeName);
  if (scheme.type === "http" && String(scheme.scheme || "").toLowerCase() === "bearer") {
    return { ktName: kotlinName, type: "String", nullable: false, extractExpr: `call.requireBearerToken("Authorization")` };
  }
  if (scheme.type === "apiKey") {
    const loc = scheme.in;
    if (loc !== "header" && loc !== "query" && loc !== "cookie") {
      throw Error(`<b2c3d4e5> apiKey security scheme "${schemeName}" has an unsupported location "in: ${loc}"`);
    }
    return {
      ktName: kotlinName,
      type: "String",
      nullable: false,
      extractExpr: `call.requireApiKey("${loc}", ${escapeKotlinString(scheme.name)})`,
    };
  }
  throw Error(
    `<c3d4e5f6> Unsupported security scheme type "${scheme.type}" for "${schemeName}" - only http/bearer and ` +
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
      `<d4e5f6a7> Operation has ${reqs.length} alternative security requirements (OR) - only a single ` +
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

// Returns a Map<tag, { tagClass, operations: [...] }> in path-declaration order.
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

        if (!groups.has(tag)) groups.set(tag, { tagClass, operations: [] });
        groups.get(tag).operations.push({
          name: opName,
          method: op.method,
          pathStr: op.path,
          pathExpr: buildPathExpr(op.path),
          summary: op.summary || null,
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
