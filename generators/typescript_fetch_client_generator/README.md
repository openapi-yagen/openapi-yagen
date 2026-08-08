# typescript_fetch_client_generator

Generates a browser-first TypeScript API client using native `fetch`, with **zero third-party
runtime dependencies**: one `interface`/`enum`/`type` alias per OpenAPI schema, plus one client
class per tag with an `async` method per operation.

The generated code owns no HTTP engine, framework state, or hooks - it works unchanged from React,
Vue, Angular, Svelte, vanilla TS/JS, or Node with a `fetch` polyfill. `fetch` itself can be
overridden per client instance (for SSR, testing, logging/retry wrappers, etc.), and request
headers can be a static object or an async callback (for a rotating/expiring bearer token).

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

Generated files aren't run through a formatter by default (Inja isn't a TS-aware pretty-printer,
so indentation/blank lines are cosmetically rough). Pipe them through
[prettier](https://prettier.io) via `openapi-yagen`'s `-p`/`--post-process` option:

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

- Only `application/json` request/response bodies are handled; other content types are ignored.
- Path/header parameters must resolve to a primitive scalar or enum (string/number/boolean) - an
  object or array in one of those positions is a generator error.
- Query parameters may be arrays, serialized as repeated keys (`?tag=a&tag=b`, OpenAPI 3's default
  `style: form, explode: true`) - other serialization styles (`explode: false`,
  `spaceDelimited`/`pipeDelimited`) are not supported.
- Only local (`#/...`) `$ref`s are supported (an engine-level constraint, not specific to this
  generator).
- `string` schemas with format `date`/`date-time`/`byte`/`binary` all map to plain `string` - no
  `Date` object, no base64/binary decoding.
- `integer`/`number` (any format) map to `number` - values beyond 2^53 lose precision.
- No runtime validation of response bodies against generated types unless `-v
  validateResponses=true` (see "Response validation" above) - off by default.
- `uniqueItems: true` is not enforced at the type level (still emitted as `T[]`, not `Set<T>`),
  including by the `validateResponses` guards.
- Generated files are not run through a formatter - see "Formatting generated sources" above.

## Try it

From the `generators/` directory, with `openapi-yagen` on `PATH` (see `run_ts_client.sh`, sibling
to `run.sh`/`run_kotlin_client.sh`):

```bash
cd generators && ./run_ts_client.sh
```

generates into `generators/out/ts-client` from `test/resources/petstore.yaml`.

For a real generate-then-typecheck-then-run check exercising every operation, positive and
negative, see [`test/`](test/) - this generator's own self-contained test suite (see also
[`../README.md`](../README.md) for the collection-wide convention):

```bash
cd generators/typescript_fetch_client_generator/test
OPENAPI_YAGEN=/path/to/openapi-yagen npm install && npm test
```
