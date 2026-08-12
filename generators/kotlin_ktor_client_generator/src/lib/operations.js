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
import { ktType } from "./types.js";
import { escapeKotlinStringContent } from "./keywords.js";
import { withResilience } from "./strict.js";

// Kotlin scalar types a path/query/header param can resolve to - the client passes these through
// directly (Kotlin string templates/`queryParam(name, value: Any?)` handle any of them, and an
// enum-typed param converts via its own generated `wireValue`/`fromWireValue`, see
// model_enum.kt.j2), so this is only ever used as a "is this actually a supported scalar shape"
// gate, not to pick a conversion snippet.
const SUPPORTED_SCALAR_PARAM_TYPES = new Set([
  "String",
  "Int",
  "Long",
  "Float",
  "Double",
  "Boolean",
  "kotlinx.datetime.LocalDate",
  "kotlinx.datetime.Instant",
]);

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

// A query parameter whose schema mixes plain scalar variant(s) with exactly one object-shaped
// variant (all-primitive properties) - a common "exact value or range filter" list-endpoint idiom
// (e.g. Stripe's `created: oneOf[integer, {gt, gte, lt, lte}]`, declared with `style: deepObject`).
// Registers the union the ordinary way (ktType/registerUnion - the same sealed-interface +
// wrapper-per-variant shape as any other union), then returns a param descriptor whose
// `queryArms` the template dispatches on at the call site: the scalar arm emits a single
// `queryParam(name, value)`; the object arm emits one `queryParam("name[field]", value)` per
// property (deepObject serialization, e.g. `created[gte]=1700000000`). Returns null (caller falls
// through to the ordinary unsupported-parameter-type error) if the shape doesn't fit - more than
// one object variant, or an object variant with a non-primitive property; those stay unsupported
// rather than guessing at a nested serialization.
function tryBuildFilterUnionQueryParam(registry, hintBase, p, schema) {
  const variants = schema.oneOf || schema.anyOf || [];
  const objectVariants = variants.filter((v) => ["Object", "Map", "AllOf"].includes(kindOf(v)));
  if (objectVariants.length !== 1) return null;
  const [objectVariant] = objectVariants;
  const objectProps = Object.entries(objectVariant.properties || {});
  if (objectProps.length === 0 || objectProps.some(([, propSchema]) => !["Primitive", "Enum"].includes(kindOf(propSchema)))) {
    return null;
  }

  const { kotlinName } = fieldName(p.name);
  const required = !!p.required;
  const t = ktType(registry, schema, hintBase + className(p.name));
  const union = registry.models.get(t.type);
  const queryArms = union.variants.map((v) => {
    if (v.dispatchKind !== "object") return { wrapperName: v.wrapperName, kind: "scalar" };
    const objectModel = registry.models.get(v.valueType);
    return {
      wrapperName: v.wrapperName,
      kind: "object",
      fields: objectModel.properties.map((f) => ({ ktName: f.ktName, wireName: f.wireName })),
    };
  });

  return {
    ktName: kotlinName,
    wireName: p.name,
    in: p.in,
    type: t.type,
    typeLabel: t.type,
    nullable: !required,
    isArray: false,
    queryArms,
    description: p.description || null,
  };
}

// A query param whose (unwrapped) schema is Array-kind - serialized as repeated `?name=a&name=b`
// keys (OpenAPI 3's default `style: form, explode: true`), matching the typescript_fetch_client
// generator's own support for this (path/header positions have no standard "repeated value"
// serialization, so those stay scalar-only).
function buildArrayQueryParam(registry, hintBase, p, itemSchema) {
  const itemT = ktType(registry, itemSchema, hintBase + className(p.name) + "Item");
  const isSupported = kindOf(unwrapSchema(itemSchema)) === "Enum" || SUPPORTED_SCALAR_PARAM_TYPES.has(itemT.type);
  if (!isSupported) {
    throw Error(
      `<01534acc> Unsupported query parameter array item type for "${p.name}": array items must be ` +
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
    queryArms: null,
    description: p.description || null,
  };
}

function buildParam(registry, hintBase, p) {
  const schema = p.schema || { type: "string" };
  const resolved = unwrapSchema(schema);
  if (p.in === "query" && kindOf(resolved) === "Array") {
    return buildArrayQueryParam(registry, hintBase, p, resolved.items || { type: "string" });
  }
  if (p.in === "query" && (kindOf(resolved) === "OneOf" || kindOf(resolved) === "AnyOf") && !isPrimitiveLikeUnion(resolved)) {
    const filterParam = tryBuildFilterUnionQueryParam(registry, hintBase, p, resolved);
    if (filterParam) return filterParam;
  }
  const t = isPrimitiveLikeUnion(resolved) ? { type: "String" } : ktType(registry, schema, hintBase + className(p.name));
  const isSupported = kindOf(resolved) === "Enum" || SUPPORTED_SCALAR_PARAM_TYPES.has(t.type);
  if (!isSupported) {
    throw Error(
      `<394d7fec> Unsupported parameter type for "${p.name}" (in: ${p.in}): only primitive scalar ` +
        `types (string/integer/number/boolean) or enums are supported in path/query/header position, got "${t.type}"`
    );
  }
  const isPath = p.in === "path";
  const required = isPath || !!p.required;
  const { kotlinName } = fieldName(p.name);
  return {
    ktName: kotlinName,
    wireName: p.name,
    in: p.in,
    type: t.type,
    typeLabel: t.type,
    nullable: !required,
    isArray: false,
    queryArms: null,
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
  return { type: t.type, required: requestBody.required === true };
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
          docComment: buildDocComment(
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
