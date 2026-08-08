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

export interface ApiClientConfig {
  /** Base URL every operation's path is resolved against, e.g. "https://api.example.com/v1". */
  baseUrl: string;
  /** Overrides the `fetch` implementation used for every request - inject a polyfill, a test
   * double, or an instrumented wrapper (logging, retries, tracing) without touching generated
   * code. Defaults to the ambient global `fetch`. */
  fetch?: typeof fetch;
  /** Headers merged into every request (a per-operation header of the same name wins). */
  headers?: HeaderProvider;
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

/** Performs one HTTP request and returns the parsed JSON response body as `T`. Throws `ApiError`
 * for any non-2xx response - the parsed (or raw-text) body is still attached to the error, so
 * callers can inspect it (e.g. a structured error payload) without a second request. */
export async function request<T>(config: ApiClientConfig, options: RequestOptions): Promise<T> {
  const doFetch = config.fetch ?? fetch;
  const url = buildUrl(config.baseUrl, options.path, options.query);

  const headers: Record<string, string> = { ...(await resolveHeaders(config.headers)) };
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      if (value !== undefined) headers[key] = value;
    }
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }

  const response = await doFetch(url, { method: options.method, headers, body, signal: options.signal });
  const parsed = await parseBody(response);
  if (!response.ok) throw new ApiError(response.status, response.statusText, parsed);
  return parsed as T;
}
