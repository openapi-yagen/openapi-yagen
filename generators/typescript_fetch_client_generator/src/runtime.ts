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
 * Provide whichever of `bearer`/`apiKey` the spec's securitySchemes actually use; an operation
 * whose required kind isn't provided throws instead of silently sending an unauthenticated
 * request. */
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

/** Which securityScheme an operation needs (see the spec's `security`/`components.securitySchemes`)
 * - generated per-operation from those, never written by hand. `location`/`name` are only set for
 * `kind: "apiKey"` (an `http`/`bearer` scheme always targets the Authorization header). */
export interface AuthRequirement {
  kind: "bearer" | "apiKey";
  location?: "header" | "query";
  name?: string;
}

export interface RequestOptions {
  method: string;
  /** Already interpolated by the caller (see each operation's generated path template); must
   * start with "/". */
  path: string;
  query?: Record<string, string | number | boolean | Array<string | number | boolean> | undefined>;
  headers?: Record<string, string | undefined>;
  /** JSON-serializable request body; entirely omitted from the request when `undefined`. */
  body?: unknown;
  signal?: AbortSignal;
  /** Only present when the generator was run with `-v validateResponses=true` - a runtime check
   * of the parsed response body against the operation's declared response type (see `request()`
   * below). Absent (not just a no-op function) when validation is off, so that mode has zero
   * runtime cost beyond the property being `undefined`. */
  validate?: (value: unknown) => boolean;
  /** Only present when the spec declares a non-empty `security` for this operation - see
   * AuthRequirement/ApiClientConfig.auth. */
  auth?: AuthRequirement;
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

function buildUrl(baseUrl: string, path: string, query: RequestOptions["query"]): string {
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
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

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Resolves `options.auth` (if the operation needs it) against `config.auth`, applying the
 * credential either as an Authorization header (bearer) or wherever the apiKey scheme's `in` says
 * (header/query - see AuthRequirement; a `cookie`-located apiKey scheme is rejected at generation
 * time, see the generator's operations.js). Mutates `headers` and returns a possibly-extended
 * `query` (an apiKey in query position can't be added to `headers`, so it's merged into the query
 * object instead, before buildUrl turns it into the URL). */
async function applyAuth(
  config: ApiClientConfig,
  options: RequestOptions,
  headers: Record<string, string>
): Promise<RequestOptions["query"]> {
  if (!options.auth) return options.query;
  const { kind } = options.auth;
  const provide = config.auth?.[kind];
  if (!provide) {
    throw new Error(
      `${options.method} ${options.path} requires "${kind}" authentication, but ApiClientConfig.auth.${kind} was not provided`
    );
  }
  const value = await provide();
  if (kind === "bearer") {
    headers["Authorization"] = `Bearer ${value}`;
    return options.query;
  }
  if (options.auth.location === "query") {
    return { ...options.query, [options.auth.name!]: value };
  }
  headers[options.auth.name!] = value;
  return options.query;
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

  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }

  const response = await doFetch(url, { method: options.method, headers, body, signal: options.signal });
  const parsed = await parseBody(response);
  if (!response.ok) throw new ApiError(response.status, response.statusText, parsed);
  if (options.validate && !options.validate(parsed)) {
    throw new ResponseValidationError(
      `Response body for ${options.method} ${options.path} does not match the expected type`,
      parsed
    );
  }
  return parsed as T;
}
