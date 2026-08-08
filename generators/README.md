# The generator collection

This directory holds a collection of `openapi-yagen` generators. Each one is meant to be a
**self-contained subproject**: easy to copy out into its own git repository, and just as easy to
drop a standalone generator from somewhere else into this collection.

## Why generators can be self-contained

`openapi-yagen`'s `-g` flag accepts a directory, a zip archive, or an HTTP(S) URL, and resolves
**every** file the generator needs - `generator.yml`, `main.js`, templates, `copyFile` sources,
even the ES-module imports inside `main.js` - strictly relative to whatever root you pointed `-g`
at. Nothing in the engine assumes a generator lives under this repo's `generators/` directory, or
knows this directory exists at all. That means a generator directory carries everything it needs
to generate code, and anything else placed alongside it (like a test project) is simply invisible
to the generation engine unless a template or script explicitly reads it.

## The `README.md` / `src/` / `test/` convention

Every generator in this collection follows the same shape:

```
generators/<name>/
  README.md   # usage docs for this generator: variables, output layout, known limitations
  src/        # everything -g points at: generator.yml, main.js, lib/, templates/
  test/       # (optional) this generator's own runtime test suite
```

- **`src/`** is the actual generator payload. `-g generators/<name>/src` is how you invoke it.
- **`README.md`** documents the generator for someone using it - not for someone testing the
  engine itself.
- **`test/`** is optional and only present once a generator has a real test suite. If present,
  it's an independently runnable project (see below) - nothing else in this repo needs to know it
  exists for the generator itself to work.

## Running one generator's tests in isolation

The Kotlin generators' test suites are ordinary Gradle/JUnit5 projects, each with its own Gradle
wrapper committed - no separate Gradle install needed, just a JDK:

```bash
cd generators/kotlin_ktor_client_generator/test
OPENAPI_YAGEN=/path/to/openapi-yagen ./gradlew test
```

Each regenerates its own code from a small "kitchen-sink" spec (`test/resources/kitchensink.yaml`)
via the `openapi-yagen` CLI, compiles it alongside hand-written tests, and actually *runs* the
generated code - server tests boot it in-memory via Ktor's `testApplication{}` against fake
handler implementations; client tests point it at `ktor-client-mock`'s `MockEngine` - asserting
on every generated operation's positive and negative (validation, not-found, etc.) behavior. No
real network or socket is involved in either.

`OPENAPI_YAGEN` points it at a prebuilt `openapi-yagen` binary. Without it, the build falls back
to this checkout's own `dist/openapi-yagen` - make sure that's up to date (`./build-musl.sh` or a
local `cmake --build`) before relying on the fallback, or just set `OPENAPI_YAGEN` explicitly.

`typescript_fetch_client_generator`'s test suite follows the same idea with a different toolchain
(npm/TypeScript instead of Gradle/JUnit5, since there's nothing Gradle-shaped to generate here):

```bash
cd generators/typescript_fetch_client_generator/test
OPENAPI_YAGEN=/path/to/openapi-yagen npm install && npm test
```

It regenerates from its own `test/resources/kitchensink.yaml`, typechecks the result with `tsc`
(once against the default extensionless import style, once against `-v importExtension=.js`), and
runs the `.js`-extension variant with Node's built-in `node:test` against a hand-rolled `fetch`
stub (`test/src/support/fetchStub.ts`) - no mocking library, same `OPENAPI_YAGEN`-env-var-with-
`dist/openapi-yagen`-fallback convention as the Gradle projects.

A generator's `test/` project has exactly one relative reference back into this repo: `../src`,
pointing at its own sibling generator directory. That's it - no root `settings.gradle.kts`/
`package.json`, no composite build, no shared build logic. This is deliberate: a `test/` project
must stay runnable completely on its own, with zero awareness of being inside this particular
checkout.

## Extracting a generator into its own repository

Because of the above, this is a plain directory copy:

```bash
cp -r generators/kotlin_ktor_client_generator /path/to/new-repo/
```

No paths need rewriting anywhere - `-g` doesn't care where the directory lives, and the `test/`
project's only repo-relative reference (`../src`) still resolves correctly since it's relative to
the generator's own directory, not to this repo's root.

## Importing a standalone generator into this collection

Drop its directory under `generators/`. If it ships its own `test/`, `./scripts/test-all-generators.sh`
(see below) will pick it up automatically - no registration or configuration needed anywhere else
in this repo.

## Reference example

`generators/kotlin_ktor_client_generator/` and `generators/kotlin_ktor_server_generator/` are the
fullest worked example of this convention for a Gradle/JVM toolchain - read their `test/`
directories if you're adding a Gradle-based test suite to another generator.
`generators/typescript_fetch_client_generator/` is the worked example for an npm/TypeScript
toolchain instead. `generators/sample_cpp_models_generator/` follows the `README.md`/`src/`
convention but doesn't have a `test/` yet (an open item, not specific to any one language or
toolchain - a future C++ generator test suite doesn't need Gradle or npm, or any particular tool
at all; it just needs to live in that generator's own `test/` directory and
regenerate-then-verify on its own).

## Running every generator's tests

```bash
./scripts/test-all-generators.sh
```

Globs `generators/*/test/build.gradle.kts` (running `./gradlew test` in each) and
`generators/*/test/package.json` (running `npm install && npm test` in each). Pure convenience
glue, not a build dependency of anything else - new generators are auto-discovered by either glob,
no registration needed anywhere.
