// Shared runtime for the generated API client - copied into the output directory verbatim (no
// per-spec substitution needed, so this is emitted via copyFile rather than a template). Every
// generated `apis/*Client.ts` file imports `request`/`ApiError`/`ApiClientConfig` from here rather
// than duplicating the fetch/header/JSON/error-handling sequence per operation.
//
// Zero third-party dependencies: only the browser/WHATWG `fetch`, `URL`, `Headers`, and
// `AbortSignal` globals are used, all of which are also available in Node.js (18+) and Deno, so
// the generated client works unmodified in any of those environments, or under a fetch polyfill.

/** Static headers, or a (possibly async) callback re-invoked on every request - the callback form
 * is what makes a rotating/expiring bearer token actually correct, since a static object captured
 * once at construction goes stale. */
export type HeaderProvider = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

/** Supplies credentials for whichever operations declare a `security` requirement (see each
 * generated method's doc comment / the spec's `components.securitySchemes`) - a callback (not a
 * plain string) for the same reason as `HeaderProvider`: a token can expire and needs re-fetching.
 * Provide whichever of `bearer`/`apiKey` the spec's securitySchemes actually use (an `oauth2`/
 * `openIdConnect` scheme is treated as `bearer` too - RFC 6750: its access token travels as
 * `Authorization: Bearer <token>` regardless of how it was obtained); an operation whose every
 * OR-alternative needs a kind you didn't provide throws instead of silently sending an
 * unauthenticated request. When an operation accepts more than one alternative way to
 * authenticate, only provide the one(s) you actually have - request() picks whichever alternative
 * is fully satisfied (see applyAuth below). */
export type AuthProvider = {
  bearer?: () => string | Promise<string>;
  apiKey?: () => string | Promise<string>;
};

export interface ApiClientConfig {
  /** Base URL every operation's path is resolved against, e.g. "https://api.example.com/v1". */
  baseUrl: string;
  /** Overrides the `fetch` implementation used for every request - inject a polyfill, a test
   * double, or an instrumented wrapper (logging, retries, tracing) without touching generated
   * code. Defaults to the ambient global `fetch`. */
  fetch?: typeof fetch;
  /** Headers merged into every request (a per-operation header of the same name wins). */
  headers?: HeaderProvider;
  /** Credentials for operations declared with a `security` requirement - see AuthProvider. */
  auth?: AuthProvider;
}

/** One securityScheme an operation needs (see the spec's `security`/`components.securitySchemes`)
 * - generated per-operation from those, never written by hand. `location`/`name` are only set for
 * `kind: "apiKey"` (an `http`/`bearer` scheme, and an `oauth2`/`openIdConnect` scheme - RFC 6750:
 * an OAuth2/OIDC access token travels as `Authorization: Bearer <token>` regardless of how it was
 * obtained - always target the Authorization header the same way). */
export interface AuthRequirement {
  kind: "bearer" | "apiKey";
  location?: "header" | "query";
  name?: string;
}

/** One OR-alternative of an operation's `security` (see the spec's own `security` array) - every
 * scheme listed must be satisfied together (AND) for this alternative to count as satisfied. A
 * single-scheme alternative is just a one-element array. */
export type AuthAlternative = AuthRequirement[];

/** How `RequestOptions.body` gets encoded on the wire. Only ever set by a generated method whose
 * requestBody declared the matching OpenAPI content-type (see the generator's operations.js):
 * "urlencoded"/"multipart" - `body` is a flat `Record<string, primitive>` (every property
 * scalar/enum, validated at generation time, never a nested object); "text" - `body` is a plain
 * `string`; "bytes" - `body` is a `Uint8Array`. */
export type BodyEncoding = "json" | "urlencoded" | "multipart" | "text" | "bytes";

/** How a 2xx response body gets parsed. Set by a generated method whenever the operation's success
 * response declared a content-type other than `application/json` (see the generator's
 * operations.js's buildResponse): "text" - the raw response text, no JSON.parse attempt; "bytes" -
 * a `Uint8Array` read from the response body. Defaults to "json" (parse as JSON, falling back to
 * raw text if that fails) when omitted - see `request()` below. Only ever applied to a 2xx
 * response; a non-2xx response is always read the "json" way regardless, since error bodies are
 * virtually always JSON/text even for an otherwise binary-bodied operation. */
export type ResponseEncoding = "json" | "text" | "bytes";

export interface RequestOptions {
  method: string;
  /** Already interpolated by the caller (see each operation's generated path template); must
   * start with "/". */
  path: string;
  query?: Record<
    string,
    | string
    | number
    | boolean
    | Array<string | number | boolean>
    // deepObject-style filter object (e.g. a Stripe-style range filter: { gte?: number }) - typed
    // loosely as `object` rather than `Record<string, ...>`: a named interface with specific
    // optional properties isn't structurally assignable to an index-signature type in TypeScript
    // even when every property matches value-wise, but buildUrl() below only ever reads its own
    // enumerable properties at runtime, so `object` is exact enough without fighting the checker.
    | object
    | undefined
  >;
  headers?: Record<string, string | undefined>;
  /** JSON-serializable request body; entirely omitted from the request when `undefined`. */
  body?: unknown;
  /** Defaults to "json" when `body` is set and this is omitted. */
  bodyEncoding?: BodyEncoding;
  /** The `Content-Type` header value to send for `bodyEncoding: "text"`/`"bytes"` - the operation's
   * exact declared media type (e.g. "text/csv", "application/octet-stream"). Ignored for the other
   * encodings, which always use a fixed Content-Type (or, for multipart, none at all - see
   * `request()` below). */
  bodyContentType?: string;
  /** Defaults to "json" when omitted - see `ResponseEncoding`. */
  responseEncoding?: ResponseEncoding;
  signal?: AbortSignal;
  /** Only present when the generator was run with `-v validateResponses=true` - a runtime check
   * of the parsed response body against the operation's declared response type (see `request()`
   * below). Absent (not just a no-op function) when validation is off, so that mode has zero
   * runtime cost beyond the property being `undefined`. */
  validate?: (value: unknown) => boolean;
  /** Only present when the spec declares a non-empty `security` for this operation: every
   * OR-alternative the operation accepts (see AuthAlternative/ApiClientConfig.auth). request()
   * uses whichever alternative's every scheme has a configured provider, trying them in the
   * spec's own declared order - see applyAuth below. */
  auth?: AuthAlternative[];
}

/** Thrown by `request()` whenever the response status is not in the 2xx range. */
export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  /** Best-effort parsed response body: JSON if the body parses as JSON, else the raw response
   * text, else `undefined` for an empty body. */
  readonly body: unknown;

  constructor(status: number, statusText: string, body: unknown) {
    super(`API error ${status} ${statusText}`);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

/** Thrown by `request()` when `-v validateResponses=true` was used and a 2xx response body
 * doesn't structurally match its declared TypeScript type - i.e. the server responded successfully
 * but with a shape the spec doesn't promise. Never thrown when the generator was run without
 * `validateResponses` (there is no way to construct this error in that build at all - `options.
 * validate` is simply never set). */
export class ResponseValidationError extends Error {
  /** The parsed response body that failed validation. */
  readonly value: unknown;

  constructor(message: string, value: unknown) {
    super(message);
    this.name = "ResponseValidationError";
    this.value = value;
  }
}

/** Encodes a flat, scalar-or-array-of-scalar object (see `BodyEncoding`'s doc comment) as an
 * "application/x-www-form-urlencoded" body string - a request body's schema is restricted to
 * scalar/enum properties or arrays of either at generation time (see operations.js's
 * requireFlatObjectSchema), so there's no nested-object/deepObject case to handle here the way a
 * query parameter's value might need (see buildUrl below). An array value sends one repeated key
 * per element (OpenAPI's default `style: form, explode: true`), same convention buildUrl already
 * applies to an array-typed query parameter. */
function encodeFormBody(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions["query"]): string {
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else if (typeof value === "object") {
        // deepObject serialization (OpenAPI `style: deepObject`) - each of the value's own
        // properties becomes its own `key[subkey]=...` pair, e.g. a Stripe-style range filter
        // (`created: { gte: 1700000000 }`) becomes `created[gte]=1700000000`.
        for (const [subKey, subValue] of Object.entries(value)) {
          if (subValue !== undefined) url.searchParams.append(`${key}[${subKey}]`, String(subValue));
        }
      } else {
        url.searchParams.append(key, String(value));
      }
    }
  }
  return url.toString();
}

async function resolveHeaders(provider: HeaderProvider | undefined): Promise<Record<string, string>> {
  if (!provider) return {};
  return typeof provider === "function" ? await provider() : provider;
}

/** `encoding` only ever governs a 2xx response - a non-2xx response always gets the permissive
 * JSON-or-fall-back-to-text treatment, regardless of what the operation's success response
 * declared, since an error body (however the operation's happy path is shaped) is virtually always
 * JSON or text, never a raw byte stream. */
async function parseBody(response: Response, encoding: ResponseEncoding): Promise<unknown> {
  if (response.ok && encoding === "bytes") {
    const buf = await response.arrayBuffer();
    return buf.byteLength === 0 ? undefined : new Uint8Array(buf);
  }
  const text = await response.text();
  if (text.length === 0) return undefined;
  if (response.ok && encoding === "text") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Resolves `options.auth` (if the operation needs it) against `config.auth`. Picks the first
 * OR-alternative (in the spec's own declared order) whose every scheme has a configured provider,
 * then applies each of that alternative's credentials - either as an Authorization header (bearer)
 * or wherever the apiKey scheme's `in` says (header/query - see AuthRequirement; a
 * `cookie`-located apiKey scheme is rejected at generation time, see the generator's
 * operations.js). This is a one-time credential-availability check, not a series of trial HTTP
 * requests: exactly one request is ever sent, using whichever alternative was picked. Mutates
 * `headers` and returns a possibly-extended `query` (an apiKey in query position can't be added to
 * `headers`, so it's merged into the query object instead, before buildUrl turns it into the
 * URL). */
async function applyAuth(
  config: ApiClientConfig,
  options: RequestOptions,
  headers: Record<string, string>
): Promise<RequestOptions["query"]> {
  if (!options.auth || options.auth.length === 0) return options.query;
  const alternative = options.auth.find((alt) => alt.every((req) => config.auth?.[req.kind]));
  if (!alternative) {
    const described = options.auth
      .map((alt) => alt.map((req) => `ApiClientConfig.auth.${req.kind}`).join(" and "))
      .join(", or ");
    throw new Error(`${options.method} ${options.path} requires ${described}, but none of those were fully provided`);
  }
  let query = options.query;
  for (const req of alternative) {
    const provide = config.auth![req.kind]!;
    const value = await provide();
    if (req.kind === "bearer") {
      headers["Authorization"] = `Bearer ${value}`;
    } else if (req.location === "query") {
      query = { ...query, [req.name!]: value };
    } else {
      headers[req.name!] = value;
    }
  }
  return query;
}

/** Performs one HTTP request and returns the parsed JSON response body as `T`. Throws `ApiError`
 * for any non-2xx response - the parsed (or raw-text) body is still attached to the error, so
 * callers can inspect it (e.g. a structured error payload) without a second request. */
export async function request<T>(config: ApiClientConfig, options: RequestOptions): Promise<T> {
  const doFetch = config.fetch ?? fetch;

  const headers: Record<string, string> = { ...(await resolveHeaders(config.headers)) };
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      if (value !== undefined) headers[key] = value;
    }
  }

  const query = await applyAuth(config, options, headers);
  const url = buildUrl(config.baseUrl, options.path, query);

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    const encoding = options.bodyEncoding ?? "json";
    if (encoding === "urlencoded") {
      body = encodeFormBody(options.body as Record<string, unknown>);
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (encoding === "multipart") {
      // An array value (including an array of Blob/File - a "multiple file upload" field) appends
      // one part per element under the same key, same convention encodeFormBody's array branch
      // uses for urlencoded - FormData has no single-call "repeated key" API of its own.
      const formData = new FormData();
      for (const [key, value] of Object.entries(options.body as Record<string, unknown>)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) formData.append(key, item as string | Blob);
        } else {
          formData.append(key, value as string | Blob);
        }
      }
      body = formData;
      // No Content-Type set here - fetch sets it itself (with the multipart boundary) once it
      // sees a FormData body; setting one ourselves would omit the boundary and break the request.
    } else if (encoding === "text") {
      body = options.body as string;
      headers["Content-Type"] = options.bodyContentType ?? "text/plain";
    } else if (encoding === "bytes") {
      // `Uint8Array<ArrayBufferLike>` (this TS/DOM lib version's default type parameter) isn't
      // structurally assignable to `BodyInit` on its own - only via `ArrayBufferView`'s wider
      // shape, which needs an explicit cast here since `body`'s declared type is `BodyInit`
      // itself, not the (correctly BodyInit-inclusive) union `fetch`'s own parameter type uses.
      body = options.body as BodyInit;
      headers["Content-Type"] = options.bodyContentType ?? "application/octet-stream";
    } else {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }
  }

  const response = await doFetch(url, { method: options.method, headers, body, signal: options.signal });
  const parsed = await parseBody(response, options.responseEncoding ?? "json");
  if (!response.ok) throw new ApiError(response.status, response.statusText, parsed);
  if (options.validate && !options.validate(parsed)) {
    throw new ResponseValidationError(
      `Response body for ${options.method} ${options.path} does not match the expected type`,
      parsed
    );
  }
  return parsed as T;
}
