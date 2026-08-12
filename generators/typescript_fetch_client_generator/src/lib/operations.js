// Groups the engine's already-merged/deref'd collectOperations() by tag, and builds a fully
// precomputed description of each operation (parameter classification, path-template expression,
// request/response types, method signature pieces) so api_client.ts.j2 stays a flat printer
// instead of re-deriving logic - same discipline as the Kotlin client generator's lib/operations.js.
//
// Everything here runs before any renderTemplate call (see main.js), while schema/parameter/
// response objects still have real JS identity - kindOf/nameOf/firstSuccessResponse only work up
// to that point.
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
  const kind = kindOf(unwrapSchema(schema));
  if (kind === "Primitive" || kind === "Enum") return tsType(registry, schema, hintName).type;
  return null;
}

function buildPathParam(registry, hintBase, p) {
  const t = scalarWireType(registry, p.schema || { type: "string" }, hintBase + typeName(p.name));
  if (!t) {
    throw Error(
      `<c5aac80e> Unsupported path parameter type for "${p.name}": only primitive scalar types ` +
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

// A query parameter whose schema mixes exactly one plain scalar variant with exactly one
// object-shaped variant (all-primitive properties) - a common "exact value or range filter"
// list-endpoint idiom (e.g. Stripe's `created: oneOf[integer, {gt, gte, lt, lte}]`, declared with
// `style: deepObject`). Unlike the Kotlin generators, this needs no special runtime dispatch at
// all: tsType() already turns the oneOf into an ordinary structural union
// (`number | { gt?: number; ... }`), and runtime.ts's buildUrl() already serializes a plain-object
// query value generically via deepObject (`key[subkey]=value`) - see there. Returns null (caller
// falls through to the ordinary unsupported-parameter-type error) if the shape doesn't fit - more
// than one object variant, more than one scalar variant, or an object variant with a
// non-primitive property.
function tryBuildFilterQueryParam(registry, hintBase, p, schema) {
  const variants = schema.oneOf || schema.anyOf || [];
  const objectVariants = variants.filter((v) => ["Object", "Map", "AllOf"].includes(kindOf(v)));
  const scalarVariants = variants.filter((v) => ["Primitive", "Enum"].includes(kindOf(v)));
  if (objectVariants.length !== 1 || scalarVariants.length !== 1) return null;
  const [objectVariant] = objectVariants;
  const objectProps = Object.entries(objectVariant.properties || {});
  if (objectProps.length === 0 || objectProps.some(([, propSchema]) => !["Primitive", "Enum"].includes(kindOf(propSchema)))) {
    return null;
  }

  const t = tsType(registry, schema, hintBase + typeName(p.name));
  return {
    tsName: paramName(p.name),
    wireName: p.name,
    tsType: t.type,
    isArray: false,
    required: !!p.required,
    description: p.description || null,
    queryKeyLiteral: propertyKeyLiteral(p.name),
  };
}

function buildQueryParam(registry, hintBase, p) {
  const schema = p.schema || { type: "string" };
  const resolved = unwrapSchema(schema);
  const kind = kindOf(resolved);
  if (kind === "OneOf" || kind === "AnyOf") {
    const filterParam = tryBuildFilterQueryParam(registry, hintBase, p, resolved);
    if (filterParam) return filterParam;
  }
  let tsTypeStr;
  let isArray = false;
  if (kind === "Array") {
    const itemType = scalarWireType(registry, resolved.items || {}, hintBase + typeName(p.name) + "Item");
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
        `<ea5e9ca2> Unsupported query parameter type for "${p.name}": only primitive scalar types ` +
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
// Uses the engine's splitPathTemplate() (see docs/javascript-api.md) instead of hand-rolling the
// same "/"-split + `{param}` regex every path-based generator otherwise needs; literal segments
// still need their own escaping here (backtick/`$`/backslash, for safe embedding inside a TS
// template literal) since that's specific to this target, not something the engine can know.
function buildPathExpr(pathStr, pathParams) {
  const byWireName = new Map(pathParams.map((p) => [p.wireName, p]));
  return (
    "/" +
    splitPathTemplate(pathStr)
      .map((seg) => {
        if ("param" in seg) {
          const p = byWireName.get(seg.param);
          if (!p) throw Error(`<e69030b8> Path parameter "{${seg.param}}" in "${pathStr}" has no matching parameter definition`);
          return "${encodeURIComponent(String(" + p.tsName + "))}";
        }
        return seg.literal.replace(/[`$\\]/g, "\\$&");
      })
      .join("/")
  );
}

// Turns an operation's already-resolved `security` (see collectOperations() in
// docs/javascript-api.md) into the object literal passed as request()'s `auth` option (see
// runtime.ts's AuthRequirement), or null if the operation needs no auth. `security` is an array of
// alternative requirement objects (OR between entries, AND between the scheme names within one) -
// only a single alternative with a single scheme is supported (the common case: one way to
// authenticate) - a client-side ApiClientConfig.auth field staying simple (one bearer/apiKey
// provider, not an array) matters more here than full spec coverage; see also the Kotlin server
// generator's buildAuthParams, which supports AND (multiple simultaneous schemes) since a Kotlin
// handler parameter list has no such ergonomic cost.
function buildAuthLiteral(op) {
  const reqs = op.security || [];
  if (reqs.length === 0) return null;
  if (reqs.length > 1) {
    throw Error(
      `<de007e6f> Operation has ${reqs.length} alternative security requirements (OR) - only a single ` +
        `requirement is supported`
    );
  }
  const schemeNames = Object.keys(reqs[0]);
  if (schemeNames.length === 0) return null; // an empty requirement object = anonymous access is allowed
  if (schemeNames.length > 1) {
    throw Error(
      `<1c503240> Operation requires ${schemeNames.length} security schemes simultaneously (AND) - only a ` +
        `single scheme per operation is supported`
    );
  }
  const schemeName = schemeNames[0];
  const scheme = ((schema.components && schema.components.securitySchemes) || {})[schemeName];
  if (!scheme) {
    throw Error(`<e9481fed> security references scheme "${schemeName}", not declared in components.securitySchemes`);
  }
  if (scheme.type === "http" && String(scheme.scheme || "").toLowerCase() === "bearer") {
    return `{ kind: "bearer" }`;
  }
  if (scheme.type === "apiKey") {
    const loc = scheme.in;
    if (loc !== "header" && loc !== "query") {
      throw Error(
        `<895cd50c> apiKey security scheme "${schemeName}" has an unsupported location "in: ${loc}" - a ` +
          `browser-first fetch client can only send it as a header or query parameter`
      );
    }
    return `{ kind: "apiKey", location: ${JSON.stringify(loc)}, name: ${JSON.stringify(scheme.name)} }`;
  }
  throw Error(
    `<f5a6b7c8> Unsupported security scheme type "${scheme.type}" for "${schemeName}" - only http/bearer and ` +
      `apiKey are currently supported`
  );
}

// Only `application/json` bodies are handled; anything else is silently ignored (see README's
// Known Limitations). `required` correctly defaults to OpenAPI 3.0's actual default (`false` when
// absent).
function buildRequestBody(registry, hintBase, requestBody) {
  if (!requestBody) return null;
  const jsonContent = (requestBody.content || {})["application/json"];
  if (!jsonContent) return null;
  const t = tsType(registry, jsonContent.schema || {}, hintBase + "Body");
  return { tsType: t.type, required: requestBody.required === true };
}

// Uses the engine's firstSuccessResponse() (see docs/javascript-api.md) instead of hand-rolling
// the same "first declared 2xx, else default" pick every response-handling generator otherwise
// needs.
function buildResponse(registry, hintBase, responses) {
  const picked = firstSuccessResponse(responses || {});
  if (!picked) return { tsType: "void", statusCode: null, descriptor: null };
  const content = (picked.response.content || {})["application/json"];
  if (!content) return { tsType: "void", statusCode: picked.statusCode, descriptor: null };
  const t = tsType(registry, content.schema || {}, hintBase + "Response");
  return { tsType: t.type, statusCode: picked.statusCode, descriptor: t.descriptor };
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

// Looks up a tag's own document-level description (schema.tags: [{name, description}] - distinct
// from op.tags, which just lists tag NAMES on an operation) for the generated API class's own
// TSDoc. null if the tag isn't declared at the document level, or has no description there (a
// spec's top-level tags: list is optional).
function tagDescription(tagName) {
  const tag = (schema.tags || []).find((t) => t.name === tagName);
  return (tag && tag.description) || null;
}

// Returns a Map<tag, { tagClass, propertyName, description, operations: [...], modelImports: [...] }> in
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

        if (!groups.has(tag))
          groups.set(tag, { tagClass, propertyName, description: tagDescription(tag), operations: [], modelImportsSet: new Set() });
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

        // An unsupported security scheme (oauth2/openIdConnect/cookie-apiKey), multiple OR
        // alternatives, or multiple simultaneous (AND) schemes only drops the auth wiring for this
        // one operation (non-strict mode) - not the whole operation, unlike the outer
        // withResilience this block runs inside of.
        let authLiteral = null;
        withResilience(
          `security for operation ${op.method.toUpperCase()} ${op.path}`,
          () => {
            authLiteral = buildAuthLiteral(op);
          },
          () => {
            authLiteral = null;
          }
        );

        group.operations.push({
          name: opName,
          method: op.method.toUpperCase(),
          docComment: buildDocComment(
            op.summary,
            op.description,
            [...pathParams, ...queryParams, ...headerParams]
              .filter((p) => p.description)
              .map((p) => ({ name: p.tsName, description: p.description }))
          ),
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
          authLiteral,
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
