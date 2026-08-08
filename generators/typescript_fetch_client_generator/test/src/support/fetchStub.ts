// Hand-rolled, dependency-free fetch stub - no mocking library, same role as
// generators/kotlin_ktor_client_generator's ktor-client-mock MockEngine but with zero npm
// dependencies. Uses only Node's built-in Response/Headers globals (available since Node 18).

export interface StubbedResponse {
  status: number;
  statusText?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
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
      body: init?.body as string | undefined,
    };
    calls.push(captured);

    const stubbed = handler(captured);
    const bodyText =
      typeof stubbed.body === "string" ? stubbed.body : stubbed.body === undefined ? "" : JSON.stringify(stubbed.body);
    // The WHATWG Response constructor rejects a non-null body alongside a "null body status"
    // (101/103/204/205/304) - pass `null` instead of "" for those so a stubbed 204 doesn't throw.
    return new Response(bodyText.length > 0 ? bodyText : null, {
      status: stubbed.status,
      statusText: stubbed.statusText ?? "",
      headers: stubbed.headers,
    });
  }) as typeof fetch;

  return { fetch: stub, calls };
}
