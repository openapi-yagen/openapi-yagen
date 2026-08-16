---
title: Kotlin Ktor server generator
sidebar_label: Kotlin Ktor server
slug: /generators/kotlin-ktor-server
description: Generate validated Ktor server routes and handler interfaces from OpenAPI.
---

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
| `strict`      | no (default `true`) | `true`: an unsupported schema/operation aborts generation with an error. `false`: skip it with a printed warning and generate everything else - useful for large real-world specs (see "Known limitations" below). |

## Output layout

```
models/<Name>.kt        one file per schema; object models also get a validate() extension
apis/<Tag>Handler.kt    interface you implement with your business logic
apis/<Tag>Routes.kt     class that wires a Route to a <Tag>Handler
Validation.kt           shared parameter-extraction/constraint-checking helpers, rendered once
```

Written flat, not nested under a `packageName`-derived directory - unlike Java, Kotlin's compiler
doesn't require a file's physical location to mirror its `package` declaration, and wherever `-o`
points already lives inside whatever package-derived source tree you're integrating into, so
another nested layer here would just be redundant.

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
    // thrown by Validation.kt - including a non-numeric value for an integer/number parameter,
    // which Validation.kt itself wraps as a BadRequestException) to HTTP 400:
    install(StatusPages) {
        exception<BadRequestException> { call, e -> call.respondText(e.message ?: "Bad request", status = HttpStatusCode.BadRequest) }
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

`format: date-time` properties/parameters generate `kotlinx.datetime.Instant` by default, which
needs `kotlinx-datetime < 0.7.0` - that release moved `Instant` to be an alias for
`kotlin.time.Instant` (Kotlin's own stdlib `Instant`, stable since Kotlin 2.1). If your project is
on `kotlinx-datetime >= 0.7.0`, generate with `-v dateTimeType=kotlin.time.Instant` instead; pass
`-v dateTimeType=String` to skip the `kotlinx-datetime` dependency for `date-time` fields entirely
(`format: date` always generates `kotlinx.datetime.LocalDate`, unaffected by this setting).

### Request body content types

Request-body content types are picked from whichever the spec declares in priority order
`application/json` > `multipart/form-data` > `application/x-www-form-urlencoded` > (a single
remaining media type, received as a `String` or raw `ByteArray`):

- **`application/json`** (default): `call.receive<Body>()`, validated the same way as always -
  the handler method's `body:` parameter is the generated `@Serializable` data class.
- **`application/x-www-form-urlencoded`**: `call.receiveParameters()`, then one field pulled/
  converted/validated per property (`Parameters.requireParamAs`/`paramAs` in `Validation.kt` - the
  same conversion/error-handling machinery query parameters already use) into that **same**
  generated data class - the handler method's signature is unaffected by which of these two
  content types the spec declares. The schema must be `type: object` with only scalar/enum
  properties (a nested object/array field is a generator error - see "Known limitations").
- **`multipart/form-data`** - the one exception to "the handler always sees a clean, typed,
  already-validated body": streaming parts/files don't fit a plain data class shape, so the
  handler method's `body:` parameter is Ktor's own
  [`io.ktor.http.content.MultiPartData`](https://api.ktor.io/ktor-http/io.ktor.http.content/-multi-part-data/)
  directly (from `call.receiveMultipart()`), not a schema-derived type:
  ```kotlin
  override suspend fun uploadPetPhoto(petId: String, body: MultiPartData) {
      body.forEachPart { part ->
          when (part) {
              is PartData.FormItem -> if (part.name == "caption") { /* ... */ }
              is PartData.FileItem -> if (part.name == "photo") { part.streamProvider().use { /* ... */ } }
              else -> {}
          }
          part.dispose()
      }
  }
  ```
- **any single `text/*` media type** (`text/plain`, `text/csv`, `text/html`, ...): `call.receive<
  String>()`, the handler method's `body:` parameter is a plain `String` - Ktor receives a `String`
  body as-is, no `ContentNegotiation` plugin needed.
- **any single other remaining media type** (`application/octet-stream`, `application/zip`,
  `application/pdf`, `image/png`, ...): `call.receive<ByteArray>()`, the handler method's `body:`
  parameter is a raw `ByteArray` - Ktor receives a `ByteArray` body as-is too. The declared schema
  (`type: string, format: binary` or otherwise) has no bearing here - the wire content-type alone
  decides `String` vs. `ByteArray`, same as it does at runtime for a real client/server.

  A requestBody declaring two or more media types outside the three fixed ones above is ambiguous
  (which one would the generated handler actually expect?) and is a generator error, same as any
  other unsupported content-type - see "Known limitations".

### Response content types

A success response's content type follows the same policy: `application/json` (default) is sent
via the ordinary `call.respond(status, result)`; a single `text/*` media type is sent via
`call.respondText(result, ContentType.parse("..."), status)`, and a single other media type via
`call.respondBytes(result, ContentType.parse("..."), status)` - both set the exact declared media
type as the response's `Content-Type` header (e.g. `text/csv`, not a generic `text/plain`), and the
handler method's return type is `String`/`ByteArray` to match. More than one remaining media type on
a response is a generator error too.

## Formatting generated sources

Templates (`templates/*.kt.j2`) emit correctly indented Kotlin directly, using Inja's `indent()`/
`{% filter %}` (see [`docs/templating.md`](../../docs/templating.md)), so a formatter isn't
required for readable output. `-p`/`--post-process` is still available for house-style polish
(import ordering, trailing commas, line-wrapping) - pipe through
[ktfmt](https://kotlin.github.io/ktfmt/):

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

## oneOf/anyOf support

- With `discriminator.propertyName` and every variant a `$ref` to a named schema: a `sealed
  interface` plus one `@Serializable` subtype per variant, dispatched by
  `JsonClassDiscriminator`.
- Otherwise (undiscriminated, and/or inline variants): a "union" model instead - a `sealed
  interface` with one value-wrapping variant per branch, deserialized by a generated, hand-rolled
  `KSerializer` (not `JsonContentPolymorphicSerializer` - its `deserialize()` is `final` and hands
  the chosen variant's own derived serializer the same unwrapped `JsonElement`, which doesn't match
  the flat wire shape a one-property wrapper class's own serializer expects) that dispatches on the
  JSON value's shape (object/array/string/number/boolean). This only works if the variants are
  pairwise distinguishable from the
  raw JSON alone: at most one variant per non-object shape, and for multiple object-shaped
  variants, each one needs a property (required or not) that no other object variant also
  declares. An unconstrained variant (a bare `{}`, matching any JSON value - a common "or
  literally anything else" idiom) is supported too, as a single trailing catch-all wrapping
  `kotlinx.serialization.json.JsonElement`, checked only after every other variant's shape fails
  to match; at most one such catch-all is allowed per oneOf/anyOf. A oneOf/anyOf that still can't
  be dispatched this way (e.g. two variants sharing the same non-object shape with nothing else to
  tell them apart, more than one catch-all, or a nested oneOf/anyOf/$ref variant) is a generator
  error (see `strict` above).
- A path/query/header **parameter's** schema is a different position - there's no JSON structure
  to dispatch on for a value that's always just a string on the wire. A oneOf/anyOf there skips
  the "union" model entirely: if every variant is itself primitive/enum-shaped, the parameter's
  Kotlin type is just `String`, passed straight through unparsed (the API decides how to interpret
  it - e.g. "either the ID or the fingerprint"); a variant that's object/array-shaped is still a
  generator error, same as for a plain (non-union) parameter.

## Known limitations (v1)

- Request and response bodies support `application/json`, a single `text/*` media type (as a
  `String`), and a single other media type (as a raw `ByteArray`); request bodies additionally
  support `application/x-www-form-urlencoded` and `multipart/form-data` (see "Request body content
  types" and "Response content types" above). **A requestBody/response declaring two or more media
  types outside those fixed ones is a generator error** (aborts generation under default
  `strict=true`; skips just that operation with a printed warning under `-v strict=false`) - it is
  never silently dropped.
- Path/query/header parameters must resolve to a primitive scalar type (string/integer/
  number/boolean), an enum, or a oneOf/anyOf whose every variant is itself primitive/enum-shaped
  (passed straight through as a plain, unparsed `String` - see "oneOf/anyOf support" above) - an
  object or array in one of those positions is a generator error. An unrecognized enum value in a
  request is rejected with a 400, same as a malformed numeric parameter.
- Body validation covers `minimum`/`maximum`/`minLength`/`maxLength`/`pattern` on direct
  properties (matching what `Validation.kt` implements), and recurses into nested object
  properties (via their own generated `validate()`) and array elements (object items via
  `validate()`, primitive items via the same constraint checks as a direct property) - but not
  into a `Map`-shaped (`additionalProperties`) property's values.
- Generated files are not run through a formatter - see "Formatting generated sources" above.

## Try it

From the `generators/` directory, with `openapi-yagen` on `PATH` (see `run_kotlin_server.sh`,
sibling to the existing `run.sh`):

```bash
cd generators && ./run_kotlin_server.sh
```
generates into `generators/out/kotlin-server` from `test/resources/petstore.yaml`.

For a real generate-then-run check exercising every operation, positive and negative, see
[`test/`](https://github.com/openapi-yagen/openapi-yagen/tree/master/generators/kotlin_ktor_server_generator/test) -
this generator's own self-contained test suite (see also
[`../README.md`](../README.md) for the collection-wide convention). `test/`'s `./gradlew test`
only runs the JVM target; `./gradlew compileKotlinLinuxX64` is what actually backs this README's
"works unchanged on every platform Ktor's server supports (JVM, Native)" claim - checked in this
repo's own CI (`.github/workflows/build.yml`'s `kotlin-native-compile-check` job).
