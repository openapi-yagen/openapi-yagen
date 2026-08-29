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

// A Faraday client isn't browser-sandboxed the way the TypeScript fetch client is (that generator
// rejects `in: cookie` entirely - the Fetch/XHR spec forbids scripts from setting a Cookie header
// at all), so this is a real, supported feature: sent via runtime.rb's build_cookie_header, same
// "one repeated key/value on the Cookie header" mechanism a cookie-located apiKey scheme uses (see
// buildAuthSchemeLiteral above).
function buildCookieParam(p) {
  requireScalarOrEnum(p, "cookie");
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

const API_KEY_LOCATIONS = { header: ":header", query: ":query", cookie: ":cookie" };

// Builds one securityScheme's Ruby auth-requirement hash literal (runtime.rb's apply_auth) -
// `oauth2`/`openIdConnect` are treated identically to `http`/`bearer` (RFC 6750: an OAuth2/OIDC
// access token travels as `Authorization: Bearer <token>` regardless of how it was obtained), and
// this generator never validates a token's scopes/claims - just presence, same as every other
// scheme. Unlike a browser-first fetch client, Faraday isn't sandboxed against setting a Cookie
// header itself, so a cookie-located apiKey scheme is a real, supported location here (not a
// generator error).
function buildAuthSchemeLiteral(schemeName) {
  const scheme = ((schema.components && schema.components.securitySchemes) || {})[schemeName];
  if (!scheme) throw Error(`<f603d9c5> security references scheme "${schemeName}", not declared in components.securitySchemes`);
  if ((scheme.type === "http" && String(scheme.scheme || "").toLowerCase() === "bearer") || scheme.type === "oauth2" || scheme.type === "openIdConnect") {
    return "{ kind: :bearer }";
  }
  if (scheme.type === "apiKey") {
    const loc = API_KEY_LOCATIONS[scheme.in];
    if (!loc) {
      throw Error(`<0714eac6> apiKey security scheme "${schemeName}" has an unsupported location "in: ${scheme.in}" - only header, query, or cookie are supported`);
    }
    return `{ kind: :api_key, location: ${loc}, name: ${toStringLiteral(scheme.name)} }`;
  }
  throw Error(
    `<1825fbd7> Unsupported security scheme type "${scheme.type}" for "${schemeName}" - only http/bearer, apiKey, ` +
      `oauth2, and openIdConnect are currently supported`
  );
}

// Turns an operation's already-resolved `security` into the Ruby array-of-arrays literal passed as
// request()'s `auth:` option (see runtime.rb's apply_auth), or null if the operation needs no auth.
// `security` is an array of alternative requirement objects (OR between entries, AND between the
// scheme names within one) - both are passed straight through to the runtime, which picks
// whichever alternative's every scheme has a configured `auth:` provider at request time. An empty
// requirement object (`{}`) as any one of the alternatives means "anonymous access is also
// accepted" per the OpenAPI spec - satisfying it trivially needs no credential, so the whole
// operation is treated as needing no auth at all.
function buildAuthLiteral(op) {
  const reqs = op.security || [];
  if (reqs.length === 0) return null;
  if (reqs.some((req) => Object.keys(req).length === 0)) return null;
  const alternatives = reqs.map((req) => Object.keys(req).map((name) => buildAuthSchemeLiteral(name)));
  return `[${alternatives.map((alt) => `[${alt.join(", ")}]`).join(", ")}]`;
}

const JSON_MEDIA_TYPE = "application/json";
const MULTIPART_MEDIA_TYPE = "multipart/form-data";
const URLENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded";

// Any "text/*" media type (text/plain, text/html, text/csv, text/markdown, ...) - a whole,
// language-level-open subtype registry, so this is a prefix check rather than a fixed set.
function isTextMediaType(mediaType) {
  return mediaType.startsWith("text/");
}

// application/x-www-form-urlencoded and multipart/form-data bodies are, by OpenAPI convention,
// always `type: object` schemas with one property per form field. A `format: binary` property is
// already classified `Primitive` by the engine's kindOf() (same as any other string), so it needs
// no special-casing here - it already passes through model registration and (de)serialization
// completely untouched, exactly like every other scalar; only the operation's own doc comment (see
// collectOperationsByTag below) gets a hint that a file-like value belongs there. A property may
// also be an array of scalar/enum items - to_h/buildToWireExpr is already fully generic over an
// "array" descriptor (no per-field metadata needed downstream: `URI.encode_www_form` already
// serializes an Array-valued Hash entry as one repeated key per element out of the box, and a
// multipart body is passed through to the caller's own Faraday::Multipart::Middleware untouched
// either way - see "Request body content types" in the README). Anything else (a nested object
// property, or an array of non-scalar items) is a generator error - same "handle the common case,
// error on the rest" policy path/header params already follow.
function requireFlatObjectSchema(bodySchema, mediaType) {
  if (kindOf(bodySchema) !== "Object") {
    throw Error(`<2f9b6b1a> A "${mediaType}" body must be an object schema (one property per form field) - got ${kindOf(bodySchema)}`);
  }
  for (const [propName, propSchema] of Object.entries(bodySchema.properties || {})) {
    const resolved = unwrapSchema(propSchema);
    const kind = kindOf(resolved);
    if (kind === "Array") {
      const itemKind = kindOf(unwrapSchema(resolved.items || {}));
      if (itemKind !== "Primitive" && itemKind !== "Enum") {
        throw Error(
          `<9c2d5e7f> Unsupported "${mediaType}" body field "${propName}": array items must be primitive ` +
            `scalar types or enums - got ${itemKind}`
        );
      }
      continue;
    }
    if (kind !== "Primitive" && kind !== "Enum") {
      throw Error(
        `<9c2d5e7f> Unsupported "${mediaType}" body field "${propName}": only primitive scalar types ` +
          `(including format: binary strings), enums, or arrays of either are supported as form fields - got ${kind}`
      );
    }
  }
}

// Picks which request-body media type is present, preferring JSON (the common case), then
// multipart (needs the flat-object check below for its file fields), then urlencoded. Failing
// those, a single remaining media type is still accepted as a raw body: "text/*" and anything else
// (application/octet-stream, application/zip, image/*, ...) are both just a plain Ruby `String` on
// the wire (Ruby has no separate byte-array type for an HTTP body - the difference is only which
// Content-Type header OpenapiYagenRuntime.request sends, see buildRequestBody below) - the wire
// content-type, not the declared schema, decides. Returns null only when `content` has entries but
// none of the above applies - more than one non-JSON/form media type is ambiguous (which one would
// the generated method actually send?) and the caller turns that into a generation error instead of
// guessing (see this generator's README "Known limitations").
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
        `"${JSON_MEDIA_TYPE}", "${MULTIPART_MEDIA_TYPE}", "${URLENCODED_MEDIA_TYPE}", a single "text/*" media ` +
        `type, or a single other media type (sent as raw bytes) are supported`
    );
  }
  // "text"/"bytes": the wire content-type alone decides how it's sent (see OpenapiYagenRuntime.
  // request's content_type: handling) regardless of the declared schema - matches actual HTTP
  // semantics (the Content-Type header is what a real client/server keys its parsing on). A plain
  // "primitive" descriptor makes bodyWireExpr/responseFromHExpr identity passthroughs (see
  // buildToWireExpr/buildFromHExpr) - `body`/`parsed` are already a plain Ruby String either way.
  if (picked.encoding === "text" || picked.encoding === "bytes") {
    return {
      label: "String",
      descriptor: { kind: "primitive" },
      required: requestBody.required === true,
      encoding: picked.encoding,
      mediaType: picked.mediaType,
    };
  }
  const bodySchema = picked.content.schema || {};
  if (picked.encoding !== "json") requireFlatObjectSchema(bodySchema, picked.mediaType);
  const t = rubyType(registry, bodySchema, hintBase + "Body");
  return { label: t.label, descriptor: t.descriptor, required: requestBody.required === true, encoding: picked.encoding, mediaType: null };
}

// Uses the engine's firstSuccessResponse() instead of hand-rolling the same "first declared 2xx,
// else default" pick every response-handling generator otherwise needs. `application/json` gets a
// real descriptor-driven type; a single remaining "text/*" or other media type both just become a
// plain Ruby `String` (Ruby has no separate byte-array type - see buildRequestBody above), read via
// OpenapiYagenRuntime.request's response_encoding: without attempting a JSON.parse. More than one
// remaining media type is still a loud error, not a guess (see README "Known limitations").
function buildResponse(registry, hintBase, responses) {
  const picked = firstSuccessResponse(responses || {});
  if (!picked) return { label: null, descriptor: null, encoding: "json", mediaType: null };
  const content = picked.response.content || {};
  if (Object.keys(content).length === 0) return { label: null, descriptor: null, encoding: "json", mediaType: null };
  const jsonContent = content[JSON_MEDIA_TYPE];
  if (jsonContent) {
    const t = rubyType(registry, jsonContent.schema || {}, hintBase + "Response");
    return { label: t.label, descriptor: t.descriptor, encoding: "json", mediaType: null };
  }
  const remaining = Object.keys(content);
  if (remaining.length === 1) {
    const mediaType = remaining[0];
    return { label: "String", descriptor: { kind: "primitive" }, encoding: isTextMediaType(mediaType) ? "text" : "bytes", mediaType };
  }
  throw Error(
    `<7e4f9a2b> Unsupported response content-type(s) [${remaining.join(", ")}] for the success response - only ` +
      `"${JSON_MEDIA_TYPE}", a single "text/*" media type, or a single other media type (as raw bytes) are ` +
      `supported`
  );
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
        const cookieParams = allParams.filter((p) => p.in === "cookie").map(buildCookieParam);

        const body = buildRequestBody(registry, hintBase, op.requestBody);
        const response = buildResponse(registry, hintBase, op.responses);
        const pathExpr = buildPathExpr(op.path, pathParams);

        const kwargs = [
          ...pathParams.map((p) => ({ rubyName: p.rubyName, required: true })),
          ...queryParams.map((p) => ({ rubyName: p.rubyName, required: p.required })),
          ...headerParams.map((p) => ({ rubyName: p.rubyName, required: p.required })),
          ...cookieParams.map((p) => ({ rubyName: p.rubyName, required: p.required })),
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

        // A `body:` keyword argument gives no hint of its own about what to pass - unlike a
        // statically-typed generator (Kotlin/TS), Ruby's method signature can't say `body: NewPet`
        // itself, so the doc comment is the only place a caller finds out without going to read
        // the model file directly. Always included (not gated behind `description` like the other
        // params below), since the class name itself - not free-text prose - is the point here.
        const docParams = [...pathParams, ...queryParams, ...headerParams, ...cookieParams]
          .filter((p) => p.description)
          .map((p) => ({ name: p.rubyName, description: p.description }));
        if (body) docParams.push({ name: "body", description: `[${body.label}]` });

        if (!groups.has(tag)) groups.set(tag, { tagClass, propertyName, description: tagDescription(tag), operations: [] });
        groups.get(tag).operations.push({
          name: opName,
          method: op.method.toLowerCase(),
          docComment: buildDocComment(op.summary, description, docParams, "#"),
          kwargs,
          pathParams,
          pathExpr,
          queryParams,
          hasQueryParams: queryParams.length > 0,
          headerParams,
          hasHeaderParams: headerParams.length > 0,
          cookieParams,
          hasCookieParams: cookieParams.length > 0,
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
