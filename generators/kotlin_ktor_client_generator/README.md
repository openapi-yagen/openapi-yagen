# kotlin_ktor_client_generator

Generates a Kotlin Multiplatform API client for [Ktor](https://ktor.io): one `@Serializable`
data class per OpenAPI schema, plus one client class per tag with a suspend function per
operation.

The generated code never picks an HTTP engine or creates an `HttpClient` itself - it takes one
in its constructor, already configured by the caller (engine, `ContentNegotiation`, auth, etc.).
That's what makes it work unchanged on every platform Ktor's client supports: JVM, Android,
iOS/Native, JS, Wasm.

## Usage

```bash
openapi-yagen g -o out -g kotlin_ktor_client_generator openapi.yaml \
    -v packageName=com.example.petstore
```

| Variable      | Required | Description                                            |
|---------------|----------|----------------------------------------------------------|
| `packageName` | yes      | Kotlin package for the generated classes (e.g. `com.example.petstore`) |

## Output layout

```
<packagePath>/models/<Name>.kt      one file per schema (data class / enum / sealed interface / typealias)
<packagePath>/apis/<Tag>Api.kt      one client class per OpenAPI tag
<packagePath>/QueryUtils.kt         small internal HttpRequestBuilder extensions, rendered once
```

## Integrating the generated code

The caller owns the `HttpClient` and must install `ContentNegotiation` with a JSON serializer
matching the generated `@Serializable` models:

```kotlin
val client = HttpClient(CIO) { // or any other engine
    install(ContentNegotiation) { json() }
}
val petsApi = PetsApi(client, baseUrl = "https://petstore.example.com/v1")
val pets = petsApi.listPets(limit = 20)
```

Add these dependencies to the module the generated code lives in:
`io.ktor:ktor-client-core`, `org.jetbrains.kotlinx:kotlinx-serialization-json`, and
`org.jetbrains.kotlinx:kotlinx-datetime` (only needed if the spec uses `date`/`date-time`
formats).

## Formatting generated sources

Generated files aren't run through a formatter by default (see `templates/*.kt.j2` - Inja isn't
a Kotlin-aware pretty-printer, so indentation/blank lines are cosmetically rough). Pipe them
through [ktfmt](https://kotlin.github.io/ktfmt/) via `openapi-yagen`'s `-p`/`--post-process`
option, which runs a command per generated file:

```bash
openapi-yagen g -o out -g kotlin_ktor_client_generator openapi.yaml \
    -v packageName=com.example.petstore \
    -p "kt:ktfmt --kotlinlang-style %file%"
```

`kt:` restricts the post-process step to `.kt` files (everything this generator emits); `%file%`
is substituted with each generated file's path. `ktfmt` formats in place, so no extra flag is
needed beyond a style choice (`--kotlinlang-style`, `--google-style` (default), or
`--dropbox-style`). Install `ktfmt` however you prefer (e.g. `brew install ktfmt`), or invoke the
jar directly instead of a `ktfmt` binary: `-p "kt:java -jar ktfmt-<version>-with-dependencies.jar --kotlinlang-style %file%"`.

Note that `-p` starts the formatter **once per generated file**, and each `ktfmt` invocation pays
its own JVM startup cost - fine for a handful of files, but it adds up for a larger spec. For
those cases it's faster to generate first and format afterwards in a single batch call listing
every file at once:

```bash
openapi-yagen g -o out -g kotlin_ktor_client_generator openapi.yaml -v packageName=com.example.petstore
find out -name "*.kt" | xargs java -jar ktfmt-<version>-with-dependencies.jar --kotlinlang-style
```

## Known limitations (v1)

- Only `application/json` request/response bodies are handled; other content types are ignored.
- Path/query/header parameters must resolve to a primitive scalar type (string/integer/
  number/boolean) - an enum, object or array in one of those positions is a generator error.
- `oneOf`/`anyOf` are only supported together with `discriminator.propertyName`, and every
  variant must be a `$ref` to a named schema. Undiscriminated `oneOf`/`anyOf` and inline
  (non-`$ref`) variants raise a clear generator error rather than guessing.
- Only local (`#/...`) `$ref`s are supported.
- Generated files are not run through a formatter - see "Formatting generated sources" above.

## Try it

From the `generators/` directory, with `openapi-yagen` on `PATH` (see `run_kotlin_client.sh`,
sibling to the existing `run.sh`):

```bash
cd generators && ./run_kotlin_client.sh
```
generates into `generators/out/kotlin-client` from `test/resources/petstore.yaml`.

For an automated generate-then-compile check (including against a real-world spec, a curated
GitHub API subset), see [`test/kotlin_generators/`](../../test/kotlin_generators/README.md).
