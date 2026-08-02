// Walks schema.paths, groups operations by tag, and builds a fully precomputed description of
// each operation (parameter extraction/validation, request/response types, Kotlin function
// signature) so the .kt.j2 templates stay close to flat printers instead of re-deriving logic.

import { deref } from "./refs.js";
import { className, fieldName, operationName } from "./naming.js";
import { ktType, extractConstraints, buildValidationCalls } from "./types.js";
import { escapeKotlinStringContent } from "./keywords.js";

// "trace" is intentionally omitted: Ktor's server routing DSL has no Route.trace() builder.
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch"];

const PARAM_CONVERTERS = {
  String: "it",
  Int: "it.toInt()",
  Long: "it.toLong()",
  Float: "it.toFloat()",
  Double: "it.toDouble()",
  Boolean: "it.toBoolean()",
};

function buildParam(root, registry, hintBase, p) {
  const t = ktType(root, registry, p.schema || { type: "string" }, hintBase + className(p.name));
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
  const constraints = extractConstraints(deref(root, p.schema || {}));
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

function buildRequestBody(root, registry, hintBase, requestBody) {
  if (!requestBody) return null;
  const rb = deref(root, requestBody);
  const jsonContent = (rb.content || {})["application/json"];
  if (!jsonContent) return null;
  const t = ktType(root, registry, jsonContent.schema || {}, hintBase + "Body");
  const model = registry.models.get(t.type);
  return { type: t.type, required: rb.required !== false, hasValidate: !!model && model.kind === "object" };
}

function buildResponse(root, registry, hintBase, responses) {
  if (!responses) return { type: "Unit", statusCode: 200 };
  const codes = Object.keys(responses)
    .filter((c) => /^2\d\d$/.test(c))
    .sort();
  const codeKey = codes[0] || (responses["default"] ? "default" : null);
  if (!codeKey) return { type: "Unit", statusCode: 200 };
  const statusCode = /^\d+$/.test(codeKey) ? parseInt(codeKey, 10) : 200;
  const resp = deref(root, responses[codeKey]);
  const content = (resp.content || {})["application/json"];
  if (!content) return { type: "Unit", statusCode };
  const t = ktType(root, registry, content.schema || {}, hintBase + "Response");
  return { type: t.type, statusCode };
}

// Returns a Map<tag, { tagClass, operations: [...] }> in path-declaration order.
export function collectOperationsByTag(root, registry) {
  const groups = new Map();
  const paths = root.paths || {};
  for (const [pathStr, pathItem] of Object.entries(paths)) {
    const commonParams = (pathItem.parameters || []).map((p) => deref(root, p));
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const merged = new Map();
      for (const p of commonParams) merged.set(`${p.in}:${p.name}`, p);
      for (const p of (op.parameters || []).map((p) => deref(root, p))) merged.set(`${p.in}:${p.name}`, p);

      const tag = (op.tags && op.tags[0]) || "Default";
      const tagClass = className(tag) + "Api";
      const opName = operationName(method, pathStr, op.operationId);
      const hintBase = tagClass + className(opName);

      const allParams = [...merged.values()].map((p) => buildParam(root, registry, hintBase, p));
      const pathParams = allParams.filter((p) => p.in === "path");
      const queryParams = allParams.filter((p) => p.in === "query");
      const headerParams = allParams.filter((p) => p.in === "header");

      const body = buildRequestBody(root, registry, hintBase, op.requestBody);
      const response = buildResponse(root, registry, hintBase, op.responses);
      const { signatureParams, handlerArgs } = buildSignature(allParams, body);

      if (!groups.has(tag)) groups.set(tag, { tagClass, operations: [] });
      groups.get(tag).operations.push({
        name: opName,
        method,
        pathStr,
        pathExpr: buildPathExpr(pathStr),
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
    }
  }
  return groups;
}
