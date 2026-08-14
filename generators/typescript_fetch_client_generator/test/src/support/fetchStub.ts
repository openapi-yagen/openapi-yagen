// Hand-rolled, dependency-free fetch stub - no mocking library, same role as
// generators/kotlin_ktor_client_generator's ktor-client-mock MockEngine but with zero npm
// dependencies. Uses only Node's built-in Response/Headers globals (available since Node 18).

export interface StubbedResponse {
  status: number;
  statusText?: string;
  /** A `Uint8Array` is sent as the raw response body (for a "bytes"-encoded response); anything
   * else is JSON.stringify'd unless it's already a string (for a "text"-encoded response, pass the
   * plain string directly - it must NOT be JSON-quoted). */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** A string for JSON/urlencoded/text bodies; a FormData for a multipart body; a Uint8Array for a
   * bytes body - see runtime.ts's BodyEncoding. */
  body: string | FormData | Uint8Array | undefined;
}

export function createFetchStub(handler: (req: CapturedRequest) => StubbedResponse) {
  const calls: CapturedRequest[] = [];

  const stub = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers)) headers[k.toLowerCase()] = v;
    }
    const captured: CapturedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body as string | FormData | Uint8Array | undefined,
    };
    calls.push(captured);

    const stubbed = handler(captured);
    // The WHATWG Response constructor rejects a non-null body alongside a "null body status"
    // (101/103/204/205/304) - pass `null` instead of an empty body for those so a stubbed 204
    // doesn't throw.
    let responseBody: BodyInit | null;
    if (stubbed.body === undefined) {
      responseBody = null;
    } else if (stubbed.body instanceof Uint8Array) {
      responseBody = stubbed.body.byteLength > 0 ? (stubbed.body as BodyInit) : null;
    } else {
      const text = typeof stubbed.body === "string" ? stubbed.body : JSON.stringify(stubbed.body);
      responseBody = text.length > 0 ? text : null;
    }
    return new Response(responseBody, {
      status: stubbed.status,
      statusText: stubbed.statusText ?? "",
      headers: stubbed.headers,
    });
  }) as typeof fetch;

  return { fetch: stub, calls };
}
