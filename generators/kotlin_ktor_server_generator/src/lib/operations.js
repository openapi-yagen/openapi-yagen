// Groups the engine's already-merged/deref'd collectOperations() by tag, and builds a fully
// precomputed description of each operation (parameter extraction/validation, request/response
// types, Kotlin function signature) so the .kt.j2 templates stay close to flat printers instead
// of re-deriving logic.
//
// Everything here runs before any renderTemplate call (see main.js), while schema/parameter/
// response objects still have real JS identity - kindOf/constraintsOf/nameOf only work up to that
// point (see README's "renderTemplate" docs on the Node round-trip that erases it afterwards).

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

function buildPathExpr(pathStr) {
  return (
    "/" +
    pathStr
      .split("/")
      .filter((s) => s.length > 0)
      .map((seg) => {
        const m = /^\{(.+)\}$/.exec(seg);
        if (m) return "${" + fieldName(m[1]).kotlinName + "}";
        return escapeKotlinStringContent(seg);
      })
      .join("/")
  );
}

function buildRequestBody(registry, hintBase, requestBody) {
  if (!requestBody) return null;
  const jsonContent = (requestBody.content || {})["application/json"];
  if (!jsonContent) return null;
  const t = ktType(registry, jsonContent.schema || {}, hintBase + "Body");
  const model = registry.models.get(t.type);
  return { type: t.type, required: requestBody.required !== false, hasValidate: !!model && model.kind === "object" };
}

function buildResponse(registry, hintBase, responses) {
  if (!responses) return { type: "Unit", statusCode: 200 };
  const codes = Object.keys(responses)
    .filter((c) => /^2\d\d$/.test(c))
    .sort();
  const codeKey = codes[0] || (responses["default"] ? "default" : null);
  if (!codeKey) return { type: "Unit", statusCode: 200 };
  const statusCode = /^\d+$/.test(codeKey) ? parseInt(codeKey, 10) : 200;
  const resp = responses[codeKey];
  const content = (resp.content || {})["application/json"];
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

        const body = buildRequestBody(registry, hintBase, op.requestBody);
        const response = buildResponse(registry, hintBase, op.responses);
        const { signatureParams, handlerArgs } = buildSignature(allParams, body);

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
