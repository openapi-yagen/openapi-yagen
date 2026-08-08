// Groups the engine's already-merged/deref'd collectOperations() by tag, and builds a fully
// precomputed description of each operation (parameter classification, path-template expression,
// request/response types, method signature pieces) so api_client.ts.j2 stays a flat printer
// instead of re-deriving logic - same discipline as the Kotlin client generator's lib/operations.js.
//
// Everything here runs before any renderTemplate call (see main.js), while schema/parameter/
// response objects still have real JS identity - kindOf/nameOf only work up to that point.
//
// Deliberately much thinner than a server-side or nominally-typed-language generator's equivalent:
// - No PARAM_CONVERTERS/extractFn table - that machinery (in the Kotlin *client* generator, mostly
//   dead code copy-pasted from its sibling *server* generator) exists to parse untyped raw HTTP
//   strings server-side; a client already has compile-time-typed values from its caller, so
//   turning a param into wire form is always just `String(value)`.
// - No constraintsOf-driven validation calls, for the same reason (see lib/types.js's header
//   comment) - a client has nothing untrusted to validate.
// - Query parameters MAY be arrays (serialized as repeated `key=v1&key=v2`, OpenAPI 3's default
//   `style: form, explode: true`) - a deliberate improvement over generators that forbid arrays in
//   query position entirely.

import { typeName, paramName, operationName, propertyKeyLiteral } from "./naming.js";
import { tsType } from "./types.js";
import { collectReferencedModelNames } from "./imports.js";
import { buildValidationExpr } from "./validation.js";
import { withResilience } from "./strict.js";

// Resolves a schema to a TS type string usable as an HTTP wire value (path/header/query scalar),
// or null if the schema isn't a primitive or enum - both of which have a well-defined single-value
// wire representation via `String(value)`. Object/Array/Map have no such representation and are
// unsupported in these positions (array is separately special-cased for *query* params only, see
// buildQueryParam).
function scalarWireType(registry, schema, hintName) {
  const kind = kindOf(schema);
  if (kind === "Primitive" || kind === "Enum") return tsType(registry, schema, hintName).type;
  return null;
}

function buildPathParam(registry, hintBase, p) {
  const t = scalarWireType(registry, p.schema || { type: "string" }, hintBase + typeName(p.name));
  if (!t) {
    throw Error(
      `<c4d5e6f7> Unsupported path parameter type for "${p.name}": only primitive scalar types ` +
        `(string/number/boolean) or enums are supported in path position`
    );
  }
  return { tsName: paramName(p.name), wireName: p.name, tsType: t, required: true, description: p.description || null };
}

function buildHeaderParam(registry, hintBase, p) {
  const t = scalarWireType(registry, p.schema || { type: "string" }, hintBase + typeName(p.name));
  if (!t) {
    throw Error(
      `<d5e6f7a8> Unsupported header parameter type for "${p.name}": only primitive scalar types ` +
        `(string/number/boolean) or enums are supported in header position`
    );
  }
  return {
    tsName: paramName(p.name),
    wireName: p.name,
    tsType: t,
    required: !!p.required,
    description: p.description || null,
    headerKeyLiteral: propertyKeyLiteral(p.name),
  };
}

function buildQueryParam(registry, hintBase, p) {
  const schema = p.schema || { type: "string" };
  const kind = kindOf(schema);
  let tsTypeStr;
  let isArray = false;
  if (kind === "Array") {
    const itemType = scalarWireType(registry, schema.items || {}, hintBase + typeName(p.name) + "Item");
    if (!itemType) {
      throw Error(
        `<e6f7a8b9> Unsupported query parameter array item type for "${p.name}": array items must be ` +
          `primitive scalars or enums`
      );
    }
    tsTypeStr = `${itemType}[]`;
    isArray = true;
  } else {
    const t = scalarWireType(registry, schema, hintBase + typeName(p.name));
    if (!t) {
      throw Error(
        `<f7a8b9c0> Unsupported query parameter type for "${p.name}": only primitive scalar types ` +
          `(string/number/boolean), enums, or arrays of those are supported in query position`
      );
    }
    tsTypeStr = t;
  }
  return {
    tsName: paramName(p.name),
    wireName: p.name,
    tsType: tsTypeStr,
    isArray,
    required: !!p.required,
    description: p.description || null,
    queryKeyLiteral: propertyKeyLiteral(p.name),
  };
}

// Turns "/pets/{petId}/ratings" into a TS template-literal path expression referencing the
// already-computed path parameter TS names, e.g. "/pets/${encodeURIComponent(String(petId))}/ratings".
// encodeURIComponent guards against a path param value containing "/" or other reserved characters.
function buildPathExpr(pathStr, pathParams) {
  const byWireName = new Map(pathParams.map((p) => [p.wireName, p]));
  return (
    "/" +
    pathStr
      .split("/")
      .filter((s) => s.length > 0)
      .map((seg) => {
        const m = /^\{(.+)\}$/.exec(seg);
        if (m) {
          const p = byWireName.get(m[1]);
          if (!p) throw Error(`<a8b9c0d1> Path parameter "{${m[1]}}" in "${pathStr}" has no matching parameter definition`);
          return "${encodeURIComponent(String(" + p.tsName + "))}";
        }
        return seg.replace(/[`$\\]/g, "\\$&");
      })
      .join("/")
  );
}

// Only `application/json` bodies are handled; anything else is silently ignored (see README's
// Known Limitations). `required` correctly defaults to OpenAPI 3.0's actual default (`false` when
// absent) - unlike the Kotlin reference generator's `requestBody.required !== false`, which
// defaults an absent `required` to `true`, the opposite of spec.
function buildRequestBody(registry, hintBase, requestBody) {
  if (!requestBody) return null;
  const jsonContent = (requestBody.content || {})["application/json"];
  if (!jsonContent) return null;
  const t = tsType(registry, jsonContent.schema || {}, hintBase + "Body");
  return { tsType: t.type, required: requestBody.required === true };
}

function buildResponse(registry, hintBase, responses) {
  if (!responses) return { tsType: "void", statusCode: null, descriptor: null };
  const codes = Object.keys(responses)
    .filter((c) => /^2\d\d$/.test(c))
    .sort();
  const codeKey = codes[0] || (responses["default"] ? "default" : null);
  if (!codeKey) return { tsType: "void", statusCode: null, descriptor: null };
  const content = (responses[codeKey].content || {})["application/json"];
  if (!content) return { tsType: "void", statusCode: codeKey, descriptor: null };
  const t = tsType(registry, content.schema || {}, hintBase + "Response");
  return { tsType: t.type, statusCode: codeKey, descriptor: t.descriptor };
}

// When `validateResponses` is enabled, builds the expression passed as request()'s `validate`
// argument for a response: a direct reference to the response type's own is<Name> guard when it's
// a named model (the common case - cheapest and most readable generated code), or an inline arrow
// function built from the descriptor for an anonymous/inline response schema (e.g. an inline
// `{type: array, items: {$ref: ...}}` with no named schema of its own - still perfectly capable of
// referencing other models' guards for its nested items, since buildValidationExpr recurses).
function buildResponseValidatorExpr(response) {
  if (!response.descriptor || response.tsType === "void") return null;
  if (response.descriptor.kind === "ref") return `is${response.descriptor.refName}`;
  return `(value: unknown): boolean => ${buildValidationExpr(response.descriptor, "value")}`;
}

// Returns a Map<tag, { tagClass, propertyName, operations: [...], modelImports: [...] }> in
// path-declaration order. `validateResponses` mirrors the generator.yml variable of the same name
// - only when true does every operation get a precomputed response.validatorExpr (see above) and
// the tag group's modelImports include the guard functions referenced by generated validators.
export function collectOperationsByTag(registry, validateResponses) {
  const groups = new Map();
  for (const op of collectOperations()) {
    // TRACE is rejected outright by the Fetch spec (browsers refuse to send it) - a generated
    // trace() method could never actually be called, so it's skipped unconditionally, same as the
    // Kotlin client generator (there, because Ktor's client DSL has no trace() builder at all).
    if (op.method === "trace") continue;

    withResilience(
      `operation ${op.method.toUpperCase()} ${op.path}`,
      () => {
        const tag = (op.tags && op.tags[0]) || "Default";
        const tagClass = typeName(tag) + "Client";
        const propertyName = paramName(tag);
        const opName = operationName(op.method, op.path, op.operationId);
        const hintBase = tagClass + typeName(opName);

        const allParams = op.parameters || [];
        const pathParams = allParams.filter((p) => p.in === "path").map((p) => buildPathParam(registry, hintBase, p));
        const queryParams = allParams.filter((p) => p.in === "query").map((p) => buildQueryParam(registry, hintBase, p));
        const headerParams = allParams.filter((p) => p.in === "header").map((p) => buildHeaderParam(registry, hintBase, p));

        const body = buildRequestBody(registry, hintBase, op.requestBody);
        const response = buildResponse(registry, hintBase, op.responses);
        const pathExpr = buildPathExpr(op.path, pathParams);

        const optionsFields = [
          ...queryParams.map((p) => ({ tsName: p.tsName, tsType: p.tsType, required: p.required, kind: "query" })),
          ...headerParams.map((p) => ({ tsName: p.tsName, tsType: p.tsType, required: p.required, kind: "header" })),
        ];
        if (body) optionsFields.push({ tsName: "body", tsType: body.tsType, required: body.required, kind: "body" });
        optionsFields.push({ tsName: "signal", tsType: "AbortSignal", required: false, kind: "signal" });
        const optionsRequired = optionsFields.some((f) => f.required);

        if (!groups.has(tag)) groups.set(tag, { tagClass, propertyName, operations: [], modelImportsSet: new Set() });
        const group = groups.get(tag);

        const referencedTypeStrings = [
          ...pathParams.map((p) => p.tsType),
          ...queryParams.map((p) => p.tsType),
          ...headerParams.map((p) => p.tsType),
          ...(body ? [body.tsType] : []),
          response.tsType,
        ];
        for (const m of collectReferencedModelNames(referencedTypeStrings, registry, null)) group.modelImportsSet.add(m);

        const validatorExpr = validateResponses ? buildResponseValidatorExpr(response) : null;

        group.operations.push({
          name: opName,
          method: op.method.toUpperCase(),
          summary: op.summary || null,
          pathParams,
          pathExpr,
          queryParams,
          headerParams,
          hasQueryParams: queryParams.length > 0,
          hasHeaderParams: headerParams.length > 0,
          body,
          hasBody: !!body,
          optionsFields,
          optionsRequired,
          response: { ...response, validatorExpr, hasValidator: validatorExpr !== null },
        });
      },
      () => {} // permissive mode: drop this operation, keep the rest of the group as-is
    );
  }
  for (const [, group] of groups) {
    group.modelImports = Array.from(group.modelImportsSet).sort();
    delete group.modelImportsSet;
  }
  return groups;
}
