---
title: Kotlin Ktor client generator
sidebar_label: Kotlin Ktor client
slug: /generators/kotlin-ktor-client
description: Generate a Kotlin Multiplatform API client that uses a caller-supplied Ktor HttpClient.
---

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
| `strict`      | no (default `true`) | `true`: an unsupported schema/operation aborts generation with an error. `false`: skip it with a printed warning and generate everything else - useful for large real-world specs (see "Known limitations" below). |
| `generate`    | no (default `all`) | `all`: models plus the API classes/bundle. `models`: only `models/<Name>.kt`. `api`: everything except `models/<Name>.kt` - see "Sharing models" below. |

## Output layout

```
models/<Name>.kt      one file per schema (data class / enum / sealed interface / typealias)
apis/<Tag>Api.kt      one client class per OpenAPI tag
ApiClient.kt          bundles one instance of every tag's client class from a shared HttpClient/baseUrl
QueryUtils.kt         small internal HttpRequestBuilder extensions, rendered once
```

Written flat, not nested under a `packageName`-derived directory - unlike Java, Kotlin's compiler
doesn't require a file's physical location to mirror its `package` declaration, and wherever `-o`
points already lives inside whatever package-derived source tree you're integrating into, so
another nested layer here would just be redundant. `packageName` is a *base* package: `models/`
is generated into `packageName.models`, `apis/` into `packageName.apis`; `ApiClient.kt` and
`QueryUtils.kt` stay at `packageName` itself.

## Sharing models with the server generator

`models/*.kt` is byte-for-byte the same output whether it comes from this generator or from
[`kotlin_ktor_server_generator`](../kotlin_ktor_server_generator/README.md) - both generate into
the same `packageName.models` sub-package and use the same template for every model kind. The
server's request-validation `.validate()` extensions live in its own `ModelValidation.kt` (at the
base `packageName`, not `.models`), specifically so this generator's model output stays free of
any server-only (`io.ktor.server.*`) dependency - safe to compile into every platform this client
already targets (JVM, Android, iOS/Native, JS, Wasm).

In a Kotlin Multiplatform monorepo, generate the models **once** into a `shared` module both the
client and server modules depend on, and skip regenerating them on either side with `-v
generate=api`:

```bash
# shared module - models only
openapi-yagen g -o shared -g kotlin_ktor_client_generator openapi.yaml \
    -v packageName=com.example.petstore -v generate=models

# client module - API classes/bundle/QueryUtils.kt, no models/
openapi-yagen g -o client -g kotlin_ktor_client_generator openapi.yaml \
    -v packageName=com.example.petstore -v generate=api

# server module - routes/handlers/Validation.kt/ModelValidation.kt, no models/
openapi-yagen g -o server -g kotlin_ktor_server_generator openapi.yaml \
    -v packageName=com.example.petstore -v generate=api
```

All three must share the same `packageName` (and `dateTimeType`, if non-default) so the types
`client`/`server` reference resolve to the `shared` module's classes.

## Integrating the generated code

The caller owns the `HttpClient` and must install `ContentNegotiation` with a JSON serializer
matching the generated `@Serializable` models. Import statements omitted below for brevity -
`ApiClient` lives at `packageName` itself, `PetsApi`/`WidgetsApi` in `packageName.apis`:

```kotlin
val client = HttpClient(CIO) { // or any other engine
    install(ContentNegotiation) { json() }
}
val api = ApiClient(client, baseUrl = "https://petstore.example.com/v1")
val pets = api.pets.listPets(limit = 20)
```

Each tag's client class (`PetsApi`, `WidgetsApi`, ...) can also be instantiated directly if you
only need one of them - `ApiClient` is just a convenience bundle:

```kotlin
val petsApi = PetsApi(client, baseUrl = "https://petstore.example.com/v1")
```

Add these dependencies to the module the generated code lives in:
`io.ktor:ktor-client-core`, `org.jetbrains.kotlinx:kotlinx-serialization-json`, and
`org.jetbrains.kotlinx:kotlinx-datetime` (only needed if the spec uses `date`/`date-time`
formats).

`format: date-time` properties/parameters generate `kotlinx.datetime.Instant` by default, which
needs `kotlinx-datetime < 0.7.0` - that release moved `Instant` to be an alias for
`kotlin.time.Instant` (Kotlin's own stdlib `Instant`, stable since Kotlin 2.1). If your project is
on `kotlinx-datetime >= 0.7.0`, generate with `-v dateTimeType=kotlin.time.Instant` instead; pass
`-v dateTimeType=String` to skip the `kotlinx-datetime` dependency for `date-time` fields entirely
(`format: date` always generates `kotlinx.datetime.LocalDate`, unaffected by this setting).

An optional property's `default` schema keyword becomes a Kotlin constructor default parameter
literal (e.g. `val priority: Int? = 1`) instead of the usual `= null` - `kotlinx.serialization`
already applies a constructor default when the JSON key is absent, and does NOT apply it for an
explicit JSON `null` (`{"priority": null}` still decodes to `priority = null`, not `1`), so no
custom (de)serializer is needed for this "absent vs. explicit null" distinction, unlike the Go
generator's equivalent. A `default` on a required property, or one whose value doesn't map to a
recognized literal shape (an object/array default), is ignored - the property keeps its ordinary
required/nullable handling.

### Request body content types

Request-body content types are picked from whichever the spec declares in priority order
`application/json` > `multipart/form-data` > `application/x-www-form-urlencoded` > (a single
remaining media type, sent as a `String` or raw `ByteArray`). The first three build the same
generated `@Serializable` data class as the `body` parameter - only how it's sent over the wire
differs:

- **`application/json`** (default): `contentType(ContentType.Application.Json); setBody(body)`.
- **`application/x-www-form-urlencoded`**: `setBody(FormDataContent(Parameters.build { ... }))`,
  one `append("wireName", body.ktName.toString())` per scalar/enum property, or one `append(...)`
  per element for an array property (one repeated `name=` key per element, OpenAPI's default
  `style: form, explode: true` - same convention an array-typed query parameter already follows).
  The schema must be `type: object` with only scalar/enum properties, or arrays of either; a
  nested object property, or an array of non-scalar items, is a generator error - see "Known
  limitations".
- **`multipart/form-data`**: same schema restriction, `setBody(MultiPartFormDataContent(formData {
  ... }))` instead - both builders come from `io.ktor.client.request.forms`, part of
  `ktor-client-core` itself (no extra Gradle dependency beyond what's already listed above). A
  `type: string, format: binary` property maps to a real Kotlin `ByteArray` (see `primitiveKtType`
  in `types.js`) and is sent as an actual multipart file part - `append("wireName", body.ktName)` -
  not a text field.
- **any single `text/*` media type** (`text/plain`, `text/csv`, `text/html`, ...): `body: String`,
  sent with `contentType(ContentType.parse("text/csv"))` (the exact declared media type, not a
  generic `text/plain`) and a plain `setBody(body)` - Ktor sends a `String` body as-is, no
  `ContentNegotiation` plugin needed.
- **any single other remaining media type** (`application/octet-stream`, `application/zip`,
  `application/pdf`, `image/png`, ...): `body: ByteArray`, sent the same way - Ktor sends a
  `ByteArray` body as-is too. This only applies to a `format: binary` schema used as the ENTIRE
  request body (not as one property of a multipart/urlencoded object) - the wire content-type
  alone decides `String` vs. `ByteArray` here, same as it does at runtime for a real client/server.

  A requestBody declaring two or more media types outside the three fixed ones above is ambiguous
  (which one would the generated method actually send?) and is a generator error, same as any other
  unsupported content-type - see "Known limitations".

## Formatting generated sources

Templates (`templates/*.kt.j2`) emit correctly indented Kotlin directly, using Inja's `indent()`/
`{% filter %}` (see [`docs/templating.md`](../../docs/templating.md)), so a formatter isn't
required for readable output. `-p`/`--post-process` is still available for house-style polish
(import ordering, trailing commas, line-wrapping) - pipe through
[ktfmt](https://kotlin.github.io/ktfmt/):

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
  types" above). **A requestBody/response declaring two or more media types outside those fixed
  ones is a generator error** (aborts generation under default `strict=true`; skips just that
  operation with a printed warning under `-v strict=false`) - it is never silently dropped.
- Path/query/header/cookie parameters must resolve to a primitive scalar type (string/integer/
  number/boolean), an enum, or a oneOf/anyOf whose every variant is itself primitive/enum-shaped
  (passed straight through as a plain, unparsed `String` - see "oneOf/anyOf support" above) - an
  object or array in one of those positions is a generator error, except a `query`-position array
  (one repeated key per element).
- Generated files are not run through a formatter - see "Formatting generated sources" above.

## Try it

From the `generators/` directory, with `openapi-yagen` on `PATH` (see `run_kotlin_client.sh`,
sibling to the existing `run.sh`):

```bash
cd generators && ./run_kotlin_client.sh
```
generates into `generators/out/kotlin-client` from `test/resources/petstore.yaml`.

For a real generate-then-run check exercising every operation, positive and negative, see
[`test/`](https://github.com/openapi-yagen/openapi-yagen/tree/master/generators/kotlin_ktor_client_generator/test) -
this generator's own self-contained test suite (see also
[`../README.md`](../README.md) for the collection-wide convention). `test/`'s `./gradlew test`
only runs the JVM target; `./gradlew compileKotlinLinuxX64` (checked in this repo's own CI -
`.github/workflows/build.yml`'s `kotlin-native-compile-check` job) additionally proves the
generated code compiles under one concrete Kotlin/Native target - not a check of every platform
"JVM, Android, iOS/Native, JS, Wasm" claims above, which would need their own toolchains/hosts
(Xcode for iOS, an Android SDK, ...), just the ordinary-JVM-toolchain-reachable one.
