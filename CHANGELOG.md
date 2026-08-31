# 0.11.0 (2026-08-31)

- Add a Docker runtime image and Linux arm64/macOS release binaries
- Add ruby_faraday_client_generator: a Ruby/Faraday API client generator with runtime type/constraint validation and JSON/urlencoded/multipart content-type handling (fails loudly on anything else) - later brought to feature parity with the other generators
- Add python_tornado_server_generator, a Tornado server generator - later brought to feature parity with the other generators, including a bump to OpenAPI 3.2
- Add go_net_http_client_generator and go_net_http_server_generator, built on Go's stdlib net/http with no external dependencies - later closed remaining gaps found vs. ogen and during general engine hardening
- Bring kotlin_ktor_client/server_generator and typescript_fetch_client_generator to feature parity with the Go generators
- Add text/* and raw-bytes request/response body support to all four client/server generators
- Add engine-level -t/--tags filtering to the generate command, documented and surfaced in the playground and generator READMEs
- Add a generate=all|models|api mode and a dateTimeType option (including kotlin.time.Instant) to both Kotlin generators, for sharing models across generated packages
- Add a browser-based playground page running the wasm-compiled engine
- Guard against runaway Inja macro recursion instead of crashing the process
- Split embedded newlines in buildDocComment's summary/description/@param text per output line
- Fix dateTimeType=kotlin.time.Instant emitting a serializer class that doesn't exist
- Split Kotlin generator output into models/apis sub-packages instead of one flat package
- Return 401 instead of 400 from the Kotlin server generator when required auth is missing
- Wildcard-import generated own-package symbols in Kotlin generators, keep third-party imports explicit
- Surface real JS error messages instead of a generic wrapper, fix a crash on builtin-thrown errors
- Force the required-field validation message to English
- Fix new template files silently missing from builtin: generators after an incremental build (embedded-generator glob wasn't rerun by CMake)
- Add Google Analytics (GA4) to the docs website
- Add the Go generators to the homepage's generator grid
- Reorganize the generators docs: move the full list from the root README into generators/README.md with a quick builtin:<name> list up front, and drop cross-generator language comparisons from each generator's own README

# 0.10.0 (2026-08-12)

- Add unwrapSchema, resolveUnionDispatch, buildDocComment (with multi-language comment-style support - /** */, //, ///, #), and disambiguateName engine built-ins for generator authors
- Substantially improve oneOf/anyOf/union and parameter handling across all three generators - catch-all, enum-typed, array-typed, and date/date-time-typed parameters, deepObject range-filter query params, name-collision disambiguation for synthetic types, and numerous crash fixes - verified against real-world specs (DigitalOcean, Stripe's full 170K-line API)
- Add an ApiClient bundle class to the Kotlin client generator (one instance of every tag's client, from a shared HttpClient/base URL), matching the TypeScript client generator
- Resolve non-standard external $ref files referenced next to a spec (a common shape for pre-bundled real-world specs)
- Embed the three built-in generators into the CLI binary (-g builtin:<name>, no local checkout or network access needed); add list-generators, extract, and info commands
- Add a documentation website, with an install → generate → use homepage walkthrough
- Add security scheme (bearer/apiKey) support to the Kotlin server and TypeScript client generators, with recursive nested/array validation and clearer parameter-parsing errors in the Kotlin server generator
- Support OpenAPI 3.0/3.1/3.2 (via a typed internal representation) and Swagger/OpenAPI 2.0 as generation input, plus a new convert command between any of those versions
- Add core built-ins for generator authors: splitPathTemplate, firstSuccessResponse, flattenAllOf (now recursive), resolveDiscriminator, toStringLiteral
- Add typescript_fetch_client_generator: a browser-native fetch-based API client generator with zero dependencies and opt-in runtime response validation
- Install to ~/.local/bin instead of /usr/local/bin, no root/sudo needed
- Generated code is now correctly indented via a forked Inja engine (indent()/{% filter %}/macros) instead of ad-hoc space-placement - template syntax fully documented
- Kotlin generators no longer nest generated output under a packageName-derived subdirectory - packageName now only sets the `package` declaration
- Fix unescaped wire names/values landing in generated Kotlin/TypeScript string literals and annotations - a spec with `"`/`\` in a property or parameter name could produce broken or unsafe generated code
- Restrict generator/template file access to the working folder - closes path-traversal, absolute-path, and shell-injection escapes an untrusted -g <url> generator could otherwise exploit
- Fix requestBody.required incorrectly defaulting to true instead of OpenAPI 3.0's actual default (false) when absent, in both Kotlin generators

# 0.9.0 (2026-08-04)

- Validate the OpenAPI spec against the official JSON Schema before generating, in the CLI and both Kotlin generators
- Add proper support for undiscriminated oneOf/anyOf schemas via a union model kind, fixing broken deserialization
- Add strict/permissive generation mode
- Add copyFile built-in
- Add a resolved OpenAPI schema graph exposed to JS, with kindOf/nameOf/constraintsOf/collectOperations built-ins and full $ref resolution
- Add identifier helper built-ins: case conversion (camelCase, snake_case, ...) and sanitizeIdentifier/isValidIdentifier
- Add Kotlin/Ktor client and server example generators
- Add log level option, add time to log messages, add time of generation
- Add dump debug helper (JS built-in and Inja template function)
- Add support for generator variables
- Add support for loading generators directly from GitHub/HTTP(S), with caching
- Add core templating capabilities: includes, calling JS-defined functions from templates, rendering to string, ES6 module imports, JS arrays in template context
- Add post processing of generated files
- Release binaries only on semver tags, document install one-liner
- Fix error when try to clean non existing directory
- Fix default values in generator options

# 0.0.1 (2024.10.12)

* Initial release
