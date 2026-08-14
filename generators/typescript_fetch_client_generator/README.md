---
title: TypeScript Fetch client generator
sidebar_label: TypeScript Fetch client
slug: /generators/typescript-fetch-client
description: Generate a browser-first TypeScript API client with no third-party runtime dependencies.
---

# typescript_fetch_client_generator

Generates a browser-first TypeScript API client using native `fetch`, with **zero third-party
runtime dependencies**: one `interface`/`enum`/`type` alias per OpenAPI schema, plus one client
class per tag with an `async` method per operation.

The generated code owns no HTTP engine, framework state, or hooks - it works unchanged from React,
Vue, Angular, Svelte, vanilla TS/JS, or Node with a `fetch` polyfill. `fetch` itself can be
overridden per client instance (for SSR, testing, logging/retry wrappers, etc.), request headers
can be a static object or an async callback (for a rotating/expiring bearer token), and an
operation with a spec-declared `security` requirement (`http`/`bearer` or `apiKey`) automatically
applies the credential from a dedicated `auth` config - see "Authentication" below.

## Usage

```bash
openapi-yagen g -o out -g typescript_fetch_client_generator openapi.yaml
```

No variable is required - unlike a generator for a nominally-typed language (e.g. this repo's
`kotlin_ktor_client_generator`, which needs a `packageName`), TypeScript has no package/namespace
system to parameterize, and the output layout below is fixed.

| Variable          | Required | Description |
|--------------------|----------|-------------|
| `strict`           | no (default `true`) | `true`: an unsupported schema/operation aborts generation with an error. `false`: skip it with a printed warning and generate everything else - useful for large real-world specs (see "Known limitations" below). |
| `importExtension`  | no (default `""`) | Suffix appended to every relative import between generated files (`from "./Pet"` vs `from "./Pet.js"`). The default (extensionless) works out of the box with every common bundler/dev-server (Vite, webpack, esbuild, Next.js, Angular CLI, SvelteKit) and `tsc`'s `"bundler"` module resolution. Set to `.js` if your build uses Node's ESM-strict resolution (`"moduleResolution": "NodeNext"`/`"Node16"`), which requires the *compiled* output extension even inside `.ts` source. |
| `validateResponses` | no (default `false`) | `false`: response bodies are trusted as-is (`JSON.parse(...) as T`), zero runtime footprint. `true`: also generate a recursive type-guard function per schema (`isPet`, `isPetStatus`, `isShape`, ...) and have every client method validate its response against one before returning, throwing `ResponseValidationError` on a mismatch - see "Response validation" below. |

## Output layout

```
models/<Name>.ts        one file per schema (interface / enum / type alias)
apis/<Tag>Client.ts     one client class per OpenAPI tag
runtime.ts              ApiClientConfig, ApiError, and the shared request() helper every client class calls
index.ts                barrel re-export of everything above, plus a composite ApiClient facade
```

## Integrating the generated code

```ts
import { ApiClient } from "./out/index";

const api = new ApiClient({ baseUrl: "https://api.example.com/v1" });
const pet = await api.pets.getPetById("123");
```

Each `<Tag>Client` class is also usable on its own (`new PetsClient(config)`) if you'd rather not
construct the whole `ApiClient` facade. Because the generated code makes no assumption about where
it runs, this works identically inside a React component, a Vue composable, an Angular service, a
Svelte store, or a plain script tag - nothing here reaches for a framework-specific global or
lifecycle hook.

`ApiClientConfig`:

```ts
export interface ApiClientConfig {
  baseUrl: string;
  fetch?: typeof fetch;   // override for SSR, testing, or an instrumented wrapper
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  auth?: { bearer?: () => string | Promise<string>; apiKey?: () => string | Promise<string> };
}
```

A rotating/expiring bearer token needs the callback form of `headers` - a static object captured
once at construction would go stale:

```ts
const api = new ApiClient({
  baseUrl: "https://api.example.com/v1",
  headers: async () => ({ Authorization: `Bearer ${await getFreshAccessToken()}` }),
});
```

### Request body content types

Request-body content types are picked from whichever the spec declares in priority order
`application/json` > `multipart/form-data` > `application/x-www-form-urlencoded` > (a single
remaining media type, sent as text or raw bytes):

- **`application/json`** (default): `options.body` is `JSON.stringify`'d, `Content-Type:
  application/json`.
- **`application/x-www-form-urlencoded`**: `options.body` (still a plain, generated-interface-typed
  object - every property scalar/enum, see "Known limitations") is encoded with `URLSearchParams`,
  `Content-Type: application/x-www-form-urlencoded`.
- **`multipart/form-data`**: same scalar/enum-only restriction, plus a `type: string, format:
  binary` property is allowed (a file field) and maps to `Blob | File` instead of the generic
  `string` a JSON body's `format: binary` field gets. `options.body` is converted to a native
  `FormData` and sent with **no** `Content-Type` set by the generated code - the browser/`fetch`
  sets it itself, boundary included:
  ```ts
  await api.pets.uploadPetPhoto(petId, {
    body: { caption: "Rex at the park", photo: fileInput.files[0] }, // photo: Blob | File
  });
  ```
  No extra dependency needed - `FormData` is as ambient a Web API as `fetch`/`URL` already relied
  on.
- **any single `text/*` media type** (`text/plain`, `text/csv`, `text/html`, ...): `options.body` is
  a plain `string`, sent as-is with `Content-Type` set to the exact declared media type (e.g.
  `text/csv`, not a generic `text/plain`).
- **any single other remaining media type** (`application/octet-stream`, `application/zip`,
  `application/pdf`, `image/png`, ...): `options.body` is a raw `Uint8Array`, sent as-is with
  `Content-Type` set to the exact declared media type. The declared schema (`type: string, format:
  binary` or otherwise) has no bearing here - the wire content-type alone decides `string` vs.
  `Uint8Array`, same as it does at runtime for a real client/server.

  A requestBody declaring two or more media types outside the three fixed ones above is ambiguous
  (which one would the generated method actually send?) and is a generator error, same as any other
  unsupported content-type - see "Known limitations".

### Authentication (`components.securitySchemes`)

An operation with a non-empty `security` in the spec gets its credential from `auth`, not
`headers` - the generated method already knows which scheme it needs (and, for `apiKey`, which
header/query parameter to put it in), so `auth` only needs to supply the raw value:

```ts
const api = new ApiClient({
  baseUrl: "https://api.example.com/v1",
  auth: {
    bearer: async () => await getFreshAccessToken(),          // http, scheme: bearer
    apiKey: () => process.env.API_KEY!,                       // apiKey (header or query)
  },
});
```

Calling a method that needs a kind of credential you didn't provide throws immediately (before any
request is sent), naming which one (`ApiClientConfig.auth.bearer`/`.apiKey`) is missing. `oauth2`/
`openIdConnect` schemes, an apiKey scheme located `in: cookie`, and an operation with more than one
simultaneous or alternative `security` requirement aren't supported yet - see "Known limitations".

Every generated method also accepts an `options.signal?: AbortSignal`, so request cancellation
(e.g. tied to a React `AbortController` cleanup, or a Vue component's unmount) works out of the box.

On any non-2xx response, the shared `request()` helper throws `ApiError` (`status`, `statusText`,
and the best-effort-parsed response `body`):

```ts
import { ApiError } from "./out/runtime";

try {
  await api.pets.getPetById("missing");
} catch (err) {
  if (err instanceof ApiError && err.status === 404) {
    // handle not-found
  } else {
    throw err;
  }
}
```

## oneOf/anyOf support

Every `oneOf`/`anyOf` - discriminated or not - becomes a plain native TS union type
(`type Shape = Circle | Square;`). Unlike a nominally-typed target (Kotlin/Java/...), TypeScript
needs no runtime dispatcher to tell union members apart: `JSON.parse` already returns a plain
value, and TS's own control-flow narrowing works directly on any shared property:

```ts
if (shape.shapeType === "circle") {
  // shape is narrowed to Circle here
}
```

For a *discriminated* union (`discriminator.propertyName` + every variant a `$ref` to a named
schema), the discriminator property on each variant is typed as its literal value (e.g.
`shapeType: "circle"`) specifically so this narrowing works. An *undiscriminated* union (or one
with inline variants) is still a perfectly usable TS union - narrow it with `typeof`, `in`, or
your own property checks instead of a single discriminator.

**By default**, there is no runtime validation that a `JSON.parse`'d response body actually matches
its declared TS type - same as most real-world TS OpenAPI generators, and the cheapest option
consistent with "zero third-party runtime dependencies." A non-2xx HTTP status always throws
`ApiError` regardless of body shape; a mismatched-shape 2xx response does not, unless you opt into
the next section.

## Response validation (opt-in)

Set `-v validateResponses=true` to additionally generate a recursive type-guard function per
schema - `export function isPet(value: unknown): value is Pet`, and likewise `isPetStatus`,
`isShape`, `isPets`, etc. Every client method calls the guard matching its own response type
before returning; if the parsed body doesn't structurally match, it throws `ResponseValidationError`
instead of returning data that only *looks* like it has the right type:

```ts
import { ResponseValidationError } from "./out/runtime";

try {
  const pet = await api.pets.getPetById("123");
} catch (err) {
  if (err instanceof ResponseValidationError) {
    // the server returned 2xx, but the body doesn't match Pet - err.value is the raw parsed body
  }
}
```

The guards are hand-generated structural checks (`typeof`/`Array.isArray`/property presence,
recursing into nested objects, arrays, and union members) - still zero third-party dependencies,
just more generated code and one extra function call per response. They're also plain exported
functions, usable on their own outside the client wherever you have an `unknown` value to narrow
(e.g. data from `localStorage`, a webhook payload, or a different API entirely).

This is off by default because it's a real trade-off, not a strict improvement: every model file
gets bigger (one guard function alongside its type), and every response pays for a recursive
structural walk. Turn it on when you don't fully trust the server to honor its own spec (a
third-party API, a backend team that iterates faster than its OpenAPI doc, a public API you don't
control) or while integrating against a not-yet-stable backend; leave it off once you trust the
contract, or for a high-volume internal API where the extra walk isn't worth paying on every call.

## Formatting generated sources

Templates (`templates/*.ts.j2`) emit correctly indented TypeScript directly, using Inja's
`indent()`/`{% filter %}` (see [`docs/templating.md`](../../docs/templating.md)), so a formatter
isn't required for readable output. `-p`/`--post-process` is still available for house-style
polish (quote style, trailing commas, line-wrapping) - pipe through
[prettier](https://prettier.io):

```bash
openapi-yagen g -o out -g typescript_fetch_client_generator openapi.yaml \
    -p "ts:prettier --write %file%"
```

`-p` starts prettier **once per generated file**; for a larger spec it's faster to generate first
and format afterwards in a single batch call:

```bash
openapi-yagen g -o out -g typescript_fetch_client_generator openapi.yaml
npx prettier --write "out/**/*.ts"
```

## Known limitations (v1)

- Request and response bodies support `application/json`, a single `text/*` media type (returned/sent
  as a plain `string`), and a single other media type (returned/sent as a raw `Uint8Array`); request
  bodies additionally support `application/x-www-form-urlencoded` and `multipart/form-data` (see
  "Request body content types" above). **A requestBody/response declaring two or more media types
  outside those fixed ones is a generator error** (aborts generation under default `strict=true`;
  skips just that operation with a printed warning under `-v strict=false`) - it is never silently
  dropped.
- Path/header parameters must resolve to a primitive scalar or enum (string/number/boolean) - an
  object or array in one of those positions is a generator error.
- Query parameters may be arrays, serialized as repeated keys (`?tag=a&tag=b`, OpenAPI 3's default
  `style: form, explode: true`) - other serialization styles (`explode: false`,
  `spaceDelimited`/`pipeDelimited`) are not supported.
- `string` schemas with format `date`/`date-time`/`byte`/`binary` all map to plain `string` - no
  `Date` object, no base64/binary decoding.
- `integer`/`number` (any format) map to `number` - values beyond 2^53 lose precision.
- No runtime validation of response bodies against generated types unless `-v
  validateResponses=true` (see "Response validation" above) - off by default.
- `uniqueItems: true` is not enforced at the type level (still emitted as `T[]`, not `Set<T>`),
  including by the `validateResponses` guards.
- `security` only supports a single scheme, of type `http`/`scheme: bearer` or `apiKey` (`in:
  header` or `in: query` - not `cookie`) - `oauth2`/`openIdConnect`, multiple schemes required
  together (AND), and multiple alternative requirements (OR) are a generator error (see
  "Authentication" above).
- Generated files are not run through a formatter - see "Formatting generated sources" above.

## Try it

From the `generators/` directory, with `openapi-yagen` on `PATH` (see `run_ts_client.sh`, sibling
to `run.sh`/`run_kotlin_client.sh`):

```bash
cd generators && ./run_ts_client.sh
```

generates into `generators/out/ts-client` from `test/resources/petstore.yaml`.

For a real generate-then-typecheck-then-run check exercising every operation, positive and
negative, see
[`test/`](https://github.com/openapi-yagen/openapi-yagen/tree/master/generators/typescript_fetch_client_generator/test) -
this generator's own self-contained test suite (see also
[`../README.md`](../README.md) for the collection-wide convention):

```bash
cd generators/typescript_fetch_client_generator/test
OPENAPI_YAGEN=/path/to/openapi-yagen npm install && npm test
```
