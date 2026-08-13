// Groups the engine's already-merged/deref'd collectOperations() by tag and builds a fully
// precomputed description of each operation (parameter names, path expression, request/response
// conversion) so templates/api_client.rb.j2 stays a flat printer - same discipline as the sibling
// generators' lib/operations.js.
//
// Deliberately narrower here than either sibling generator needs to be for QUERY parameters
// specifically: Ruby has no static type system, so a query parameter's Ruby-side value is passed
// straight through into the shared query hash and runtime.rb's own build_query walks it
// generically at request time (scalar, Array -> repeated key, Hash -> deepObject `key[sub]=v`) -
// there's no per-parameter code to generate, unlike TypeScript/Kotlin, which both need to know a
// query parameter's shape up front to emit correctly-typed code. Path and header parameters still
// need a single unambiguous wire string, so those two positions keep the same
// scalar/enum-or-Error validation the sibling generators apply (see buildPathParam/
// buildHeaderParam below).

import { className, paramName, operationName } from "./naming.js";
import { rubyType } from "./types.js";
import { buildFromHExpr, buildToWireExpr } from "./serialization.js";
import { withResilience } from "./strict.js";

function requireScalarOrEnum(p, position) {
  const resolved = unwrapSchema(p.schema || { type: "string" });
  const kind = kindOf(resolved);
  if (kind !== "Primitive" && kind !== "Enum") {
    throw Error(
      `<b3f0a6d1> Unsupported ${position} parameter type for "${p.name}": only primitive scalar ` +
        `types (string/number/boolean) or enums are supported in ${position} position`
    );
  }
}

function buildPathParam(p) {
  requireScalarOrEnum(p, "path");
  return { rubyName: paramName(p.name), wireName: p.name, description: p.description || null };
}

function buildHeaderParam(p) {
  requireScalarOrEnum(p, "header");
  return { rubyName: paramName(p.name), wireName: p.name, required: !!p.required, description: p.description || null };
}

// No shape restriction (see this file's header comment) - the wire name is all the generated code
// needs; runtime.rb's build_query handles scalar/Array/Hash generically at request time.
function buildQueryParam(p) {
  return { rubyName: paramName(p.name), wireName: p.name, required: !!p.required, description: p.description || null };
}

// Turns "/pets/{petId}/ratings" into a Ruby double-quoted string-interpolation path expression
// referencing the already-computed path parameter Ruby names, e.g.
// "/pets/#{OpenapiYagenRuntime.escape_path_segment(pet_id)}/ratings". Uses the engine's
// splitPathTemplate() instead of hand-rolling the same "/"-split + `{param}` regex every
// path-based generator otherwise needs; literal segments still need their own escaping for safe
// embedding inside a Ruby double-quoted string (", #, and \\).
function buildPathExpr(pathStr, pathParams) {
  const byWireName = new Map(pathParams.map((p) => [p.wireName, p]));
  return (
    "/" +
    splitPathTemplate(pathStr)
      .map((seg) => {
        if ("param" in seg) {
          const p = byWireName.get(seg.param);
          if (!p) throw Error(`<c1a9e6c2> Path parameter "{${seg.param}}" in "${pathStr}" has no matching parameter definition`);
          return "#{OpenapiYagenRuntime.escape_path_segment(" + p.rubyName + ")}";
        }
        return seg.literal.replace(/["#\\]/g, "\\$&");
      })
      .join("/")
  );
}

// Turns an operation's already-resolved `security` into the Ruby hash literal passed as
// request()'s `auth:` option (see runtime.rb), or null if the operation needs no auth. Same
// single-alternative/single-scheme restriction as the TypeScript generator's buildAuthLiteral, for
// the same reason: a caller-facing `auth:` config staying a plain `{ bearer:, api_key: }` hash
// matters more here than covering every possible spec-legal combination.
function buildAuthLiteral(op) {
  const reqs = op.security || [];
  if (reqs.length === 0) return null;
  if (reqs.length > 1) {
    throw Error(`<d4e1b7a3> Operation has ${reqs.length} alternative security requirements (OR) - only a single requirement is supported`);
  }
  const schemeNames = Object.keys(reqs[0]);
  if (schemeNames.length === 0) return null; // an empty requirement object = anonymous access is allowed
  if (schemeNames.length > 1) {
    throw Error(`<e5f2c8b4> Operation requires ${schemeNames.length} security schemes simultaneously (AND) - only a single scheme per operation is supported`);
  }
  const schemeName = schemeNames[0];
  const scheme = ((schema.components && schema.components.securitySchemes) || {})[schemeName];
  if (!scheme) throw Error(`<f603d9c5> security references scheme "${schemeName}", not declared in components.securitySchemes`);
  if (scheme.type === "http" && String(scheme.scheme || "").toLowerCase() === "bearer") {
    return "{ kind: :bearer }";
  }
  if (scheme.type === "apiKey") {
    const loc = scheme.in;
    if (loc !== "header" && loc !== "query") {
      throw Error(`<0714eac6> apiKey security scheme "${schemeName}" has an unsupported location "in: ${loc}" - only header or query are supported`);
    }
    return `{ kind: :api_key, location: ${loc === "header" ? ":header" : ":query"}, name: ${toStringLiteral(scheme.name)} }`;
  }
  throw Error(`<1825fbd7> Unsupported security scheme type "${scheme.type}" for "${schemeName}" - only http/bearer and apiKey are currently supported`);
}

const JSON_MEDIA_TYPE = "application/json";
const MULTIPART_MEDIA_TYPE = "multipart/form-data";
const URLENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded";

// application/x-www-form-urlencoded and multipart/form-data bodies are, by OpenAPI convention,
// always `type: object` schemas with one property per form field. A `format: binary` property is
// already classified `Primitive` by the engine's kindOf() (same as any other string), so it needs
// no special-casing here - it already passes through model registration and (de)serialization
// completely untouched, exactly like every other scalar; only the operation's own doc comment (see
// collectOperationsByTag below) gets a hint that a file-like value belongs there. Anything else (a
// nested object/array property) is a generator error - same "handle the common case, error on the
// rest" policy path/header params already follow.
function requireFlatObjectSchema(bodySchema, mediaType) {
  if (kindOf(bodySchema) !== "Object") {
    throw Error(`<2f9b6b1a> A "${mediaType}" body must be an object schema (one property per form field) - got ${kindOf(bodySchema)}`);
  }
  for (const [propName, propSchema] of Object.entries(bodySchema.properties || {})) {
    const kind = kindOf(unwrapSchema(propSchema));
    if (kind !== "Primitive" && kind !== "Enum") {
      throw Error(
        `<9c2d5e7f> Unsupported "${mediaType}" body field "${propName}": only primitive scalar types ` +
          `(including format: binary strings) or enums are supported as form fields - got ${kind}`
      );
    }
  }
}

// Picks which of the three supported request-body media types is present, preferring JSON (the
// common case), then multipart (needs the flat-object check below for its file fields), then
// urlencoded. Returns null if `content` has entries but none of the three - the caller turns that
// into a generation error instead of silently treating the operation as bodyless (see this
// generator's README "Known limitations").
function pickBodyContent(content) {
  if (content[JSON_MEDIA_TYPE]) return { mediaType: JSON_MEDIA_TYPE, content: content[JSON_MEDIA_TYPE], encoding: "json" };
  if (content[MULTIPART_MEDIA_TYPE]) return { mediaType: MULTIPART_MEDIA_TYPE, content: content[MULTIPART_MEDIA_TYPE], encoding: "multipart" };
  if (content[URLENCODED_MEDIA_TYPE]) return { mediaType: URLENCODED_MEDIA_TYPE, content: content[URLENCODED_MEDIA_TYPE], encoding: "urlencoded" };
  return null;
}

// `required` correctly defaults to OpenAPI 3.0's actual default (`false` when absent). A
// requestBody with `content: {}` (no media types at all - pathological, but not the same thing as
// "declared with content the generator can't handle") is treated as bodyless, same as no
// requestBody at all; anything present-but-unhandled is a loud error (see pickBodyContent).
function buildRequestBody(registry, hintBase, requestBody) {
  if (!requestBody) return null;
  const content = requestBody.content || {};
  if (Object.keys(content).length === 0) return null;
  const picked = pickBodyContent(content);
  if (!picked) {
    throw Error(
      `<5b8a1c3d> Unsupported request body content-type(s) [${Object.keys(content).join(", ")}] - only ` +
        `"${JSON_MEDIA_TYPE}", "${MULTIPART_MEDIA_TYPE}", and "${URLENCODED_MEDIA_TYPE}" are supported`
    );
  }
  const bodySchema = picked.content.schema || {};
  if (picked.encoding !== "json") requireFlatObjectSchema(bodySchema, picked.mediaType);
  const t = rubyType(registry, bodySchema, hintBase + "Body");
  return { label: t.label, descriptor: t.descriptor, required: requestBody.required === true, encoding: picked.encoding };
}

// Uses the engine's firstSuccessResponse() instead of hand-rolling the same "first declared 2xx,
// else default" pick every response-handling generator otherwise needs. Responses stay
// JSON-only - multipart/urlencoded responses are vanishingly rare in practice and out of scope for
// now (see README "Known limitations") - so, unlike buildRequestBody, there's only one media type
// to accept; anything else present is still a loud error, not a silent "void" response.
function buildResponse(registry, hintBase, responses) {
  const picked = firstSuccessResponse(responses || {});
  if (!picked) return { label: null, descriptor: null };
  const content = picked.response.content || {};
  if (Object.keys(content).length === 0) return { label: null, descriptor: null };
  const jsonContent = content[JSON_MEDIA_TYPE];
  if (!jsonContent) {
    throw Error(
      `<7e4f9a2b> Unsupported response content-type(s) [${Object.keys(content).join(", ")}] for the success ` +
        `response - only "${JSON_MEDIA_TYPE}" is supported`
    );
  }
  const t = rubyType(registry, jsonContent.schema || {}, hintBase + "Response");
  return { label: t.label, descriptor: t.descriptor };
}

// Looks up a tag's own document-level description (schema.tags: [{name, description}]) for the
// generated client class's own doc comment.
function tagDescription(tagName) {
  const tag = (schema.tags || []).find((t) => t.name === tagName);
  return (tag && tag.description) || null;
}

// Returns a Map<tag, { tagClass, propertyName, description, operations: [...] }> in
// path-declaration order.
export function collectOperationsByTag(registry) {
  const groups = new Map();
  for (const op of collectOperations()) {
    withResilience(
      `operation ${op.method.toUpperCase()} ${op.path}`,
      () => {
        const tag = (op.tags && op.tags[0]) || "Default";
        const tagClass = className(tag) + "Client";
        const propertyName = paramName(tag);
        const opName = operationName(op.method, op.path, op.operationId);
        const hintBase = tagClass + className(opName);

        const allParams = op.parameters || [];
        const pathParams = allParams.filter((p) => p.in === "path").map(buildPathParam);
        const queryParams = allParams.filter((p) => p.in === "query").map(buildQueryParam);
        const headerParams = allParams.filter((p) => p.in === "header").map(buildHeaderParam);

        const body = buildRequestBody(registry, hintBase, op.requestBody);
        const response = buildResponse(registry, hintBase, op.responses);
        const pathExpr = buildPathExpr(op.path, pathParams);

        const kwargs = [
          ...pathParams.map((p) => ({ rubyName: p.rubyName, required: true })),
          ...queryParams.map((p) => ({ rubyName: p.rubyName, required: p.required })),
          ...headerParams.map((p) => ({ rubyName: p.rubyName, required: p.required })),
        ];
        if (body) kwargs.push({ rubyName: "body", required: body.required });

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

        // A multipart body's `format: binary` field(s) pass through untouched (see
        // requireFlatObjectSchema above) - the only place that can hint what to actually pass is
        // the operation's own doc comment, since the property itself carries no such marker. Joined
        // with a single space (not a blank line) - buildDocComment's "#" style gives each of
        // summary/description exactly one leading "#", it doesn't re-split an already-multi-line
        // string per embedded newline, so an inserted "\n\n" here would print as unprefixed raw
        // text instead of a second commented paragraph.
        let description = op.description || null;
        if (body && body.encoding === "multipart") {
          const hint =
            "For multipart/form-data: a `format: binary` field expects a Faraday::Multipart::FilePart " +
            '(gem "faraday-multipart"), a File, or an IO.';
          description = description ? `${description} ${hint}` : hint;
        }

        if (!groups.has(tag)) groups.set(tag, { tagClass, propertyName, description: tagDescription(tag), operations: [] });
        groups.get(tag).operations.push({
          name: opName,
          method: op.method.toLowerCase(),
          docComment: buildDocComment(
            op.summary,
            description,
            [...pathParams, ...queryParams, ...headerParams]
              .filter((p) => p.description)
              .map((p) => ({ name: p.rubyName, description: p.description })),
            "#"
          ),
          kwargs,
          pathParams,
          pathExpr,
          queryParams,
          hasQueryParams: queryParams.length > 0,
          headerParams,
          hasHeaderParams: headerParams.length > 0,
          body,
          bodyWireExpr: body ? buildToWireExpr(body.descriptor, "body") : null,
          response,
          hasResponse: !!response.descriptor,
          responseFromHExpr: response.descriptor ? buildFromHExpr(response.descriptor, "parsed") : null,
          authLiteral,
        });
      },
      () => {} // permissive mode: drop this operation, keep the rest of the group as-is
    );
  }
  return groups;
}
