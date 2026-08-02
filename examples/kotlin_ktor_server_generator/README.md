# kotlin_ktor_server_generator

Generates [Ktor](https://ktor.io) server routing for an OpenAPI spec: one `@Serializable` data
class per schema, and per tag a routing class plus a handler interface you implement.

The routing class takes a `io.ktor.server.routing.Route` in its constructor (so you control mount
path, prefix and interceptors) and an implementation of the generated handler interface. It never
picks an engine or creates the server itself, so it works unchanged on every platform Ktor's
server supports (JVM, Native).

Incoming requests are parsed and validated - path/query/header parameters and, for bodies whose
schema has constraints, the deserialized body - **before** the handler is called, so handler
implementations only ever see clean, typed, already-valid Kotlin values. All constraint-checking
logic lives once in the generated `Validation.kt` and is called from every operation/model instead
of being duplicated per handler.

## Usage

```bash
openapi-yagen g -o out -g kotlin_ktor_server_generator openapi.yaml \
    -v packageName=com.example.petstore
```

| Variable      | Required | Description                                            |
|---------------|----------|----------------------------------------------------------|
| `packageName` | yes      | Kotlin package for the generated classes (e.g. `com.example.petstore`) |

## Output layout

```
<packagePath>/models/<Name>.kt        one file per schema; object models also get a validate() extension
<packagePath>/apis/<Tag>Handler.kt    interface you implement with your business logic
<packagePath>/apis/<Tag>Routes.kt     class that wires a Route to a <Tag>Handler
<packagePath>/Validation.kt           shared parameter-extraction/constraint-checking helpers, rendered once
```

## Integrating the generated code

```kotlin
class PetsService : PetsApiHandler {
    override suspend fun listPets(limit: Int?): Pets = TODO()
    override suspend fun createPets(body: Pet) { TODO() }
    override suspend fun showPetById(petId: String): Pet = TODO()
}

fun Application.module() {
    install(ContentNegotiation) { json() }
    // Map validation failures (BadRequestException/MissingRequestParameterException, both
    // thrown by Validation.kt) and numeric parse failures to HTTP 400:
    install(StatusPages) {
        exception<BadRequestException> { call, e -> call.respondText(e.message ?: "Bad request", status = HttpStatusCode.BadRequest) }
        exception<NumberFormatException> { call, e -> call.respondText("Invalid parameter", status = HttpStatusCode.BadRequest) }
    }
    routing {
        PetsApiRoutes(this, PetsService())
    }
}
```

Add these dependencies to the module the generated code lives in: `io.ktor:ktor-server-core`,
`org.jetbrains.kotlinx:kotlinx-serialization-json`, and `org.jetbrains.kotlinx:kotlinx-datetime`
(only needed if the spec uses `date`/`date-time` formats). Add `io.ktor:ktor-server-status-pages`
if you use the `StatusPages` mapping shown above (recommended).

## Formatting generated sources

Generated files aren't run through a formatter by default (see `templates/*.kt.j2` - Inja isn't
a Kotlin-aware pretty-printer, so indentation/blank lines are cosmetically rough). Pipe them
through [ktfmt](https://kotlin.github.io/ktfmt/) via `openapi-yagen`'s `-p`/`--post-process`
option, which runs a command per generated file:

```bash
openapi-yagen g -o out -g kotlin_ktor_server_generator openapi.yaml \
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
openapi-yagen g -o out -g kotlin_ktor_server_generator openapi.yaml -v packageName=com.example.petstore
find out -name "*.kt" | xargs java -jar ktfmt-<version>-with-dependencies.jar --kotlinlang-style
```

## Known limitations (v1)

- Only `application/json` request/response bodies are handled; other content types are ignored.
- Path/query/header parameters must resolve to a primitive scalar type (string/integer/
  number/boolean) - an enum, object or array in one of those positions is a generator error.
  Numeric/boolean parameter conversion (`toInt()`/`toBoolean()`/...) throws `NumberFormatException`
  on bad input rather than a `BadRequestException` - map it via `StatusPages` as shown above.
- `oneOf`/`anyOf` are only supported together with `discriminator.propertyName`, and every
  variant must be a `$ref` to a named schema. Undiscriminated `oneOf`/`anyOf` and inline
  (non-`$ref`) variants raise a clear generator error rather than guessing.
- Body validation only covers `minimum`/`maximum`/`minLength`/`maxLength`/`pattern` on direct
  properties (matching what `Validation.kt` implements) - it does not recurse into nested object
  or array element constraints.
- Only local (`#/...`) `$ref`s are supported.
- Generated files are not run through a formatter - see "Formatting generated sources" above.

## Try it

From the `examples/` directory, with `openapi-yagen` on `PATH` (see `run_kotlin_server.sh`,
sibling to the existing `run.sh`):

```bash
cd examples && ./run_kotlin_server.sh
```
generates into `examples/out/kotlin-server` from `test/resources/petstore.yaml`.

For an automated generate-then-compile check (including against a real-world spec, a curated
GitHub API subset), see [`test/kotlin_generators/`](../../test/kotlin_generators/README.md).
