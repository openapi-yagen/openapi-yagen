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

## oneOf/anyOf support

- With `discriminator.propertyName` and every variant a `$ref` to a named schema: a `sealed
  interface` plus one `@Serializable` subtype per variant, dispatched by
  `JsonClassDiscriminator`.
- Otherwise (undiscriminated, and/or inline variants): a "union" model instead - a `sealed
  interface` with one value-wrapping variant per branch, deserialized by a generated
  `JsonContentPolymorphicSerializer` that dispatches on the JSON value's shape (object/array/
  string/number/boolean). This only works if the variants are pairwise distinguishable from the
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

- Only `application/json` request/response bodies are handled; other content types are ignored.
- Path/query/header parameters must resolve to a primitive scalar type (string/integer/
  number/boolean), an enum, or a oneOf/anyOf whose every variant is itself primitive/enum-shaped
  (passed straight through as a plain, unparsed `String` - see "oneOf/anyOf support" above) - an
  object or array in one of those positions is a generator error.
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
