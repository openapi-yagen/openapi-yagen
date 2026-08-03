# Kotlin generator integration tests

Integration tests for `generators/kotlin_ktor_client_generator` and
`generators/kotlin_ktor_server_generator`: for both generators, against both a clean textbook spec
(`test/resources/petstore.yaml`) and a real-world one (`test/resources/ghes-3.15.yaml`, the full,
real GitHub Enterprise Server REST API spec - see below), generate Kotlin source with
`openapi-yagen` and then compile it with `kotlinc`. A case only passes if both generation and
compilation succeed.

These are separate from the C++ Catch2 suite under `test/` (`../CMakeLists.txt`) - they exercise
a full generate-then-compile round trip through an external toolchain (JVM/Kotlin/Gradle), which
the core project doesn't otherwise depend on, so they're not wired into the default CMake build
or CI (`.github/workflows/build.yml`). Run them manually, or wire `run_tests.sh` into your own CI
job if you have the prerequisites available there.

## Prerequisites

- An `openapi-yagen` binary - build one first (e.g. `./build-musl.sh` from the repo root, or a
  local `cmake --build`). Defaults to `dist/openapi-yagen`; override with `OPENAPI_YAGEN=/path/to/binary`.
- `kotlinc` on `PATH` (e.g. `sdk install kotlin` via [SDKMAN](https://sdkman.io)).
- `gradle` on `PATH` - used once per run to resolve the JVM classpath (`ktor-client-core`,
  `ktor-server-core`, `kotlinx-serialization-json`, `kotlinx-datetime`) declared in
  `classpath/build.gradle.kts`; needs network access for the first resolve (Gradle caches after
  that in `~/.gradle`).

## Running

```bash
./test/kotlin_generators/run_tests.sh
```

Prints one `OK`/`FAIL` per case (`client-petstore`, `server-petstore`, `client-github`,
`server-github`) and exits non-zero if any failed, with the `kotlinc` output for the failing
case(s).

## The GitHub fixture

`test/resources/ghes-3.15.yaml` is the full, real GitHub Enterprise Server 3.15 spec (216k
lines), used as-is - it isn't hand-edited or trimmed down, since doing that would mean testing
against something other than a real third-party spec. It's large and contains plenty of
constructs the generators don't support yet (undiscriminated `oneOf`/`anyOf` that can't be
disambiguated from the raw JSON shape, enum-typed path/query parameters, etc. - see each
generator's README for the current feature set), so the `client-github`/`server-github` cases run
it with `-v strict=false`: unsupported schemas/operations are skipped with a warning instead of
failing the whole generation (see the `strict` generator variable). The `client-petstore`/
`server-petstore` cases keep the default `strict=true` (the textbook spec is fully supported, so
nothing should ever need to fall back there - if it starts warning, that's a regression).

## Relationship to each generator's own `test/`

There's a second, complementary testing tier: each Kotlin generator also has its own
self-contained `test/` subdirectory (`generators/kotlin_ktor_client_generator/test/`,
`generators/kotlin_ktor_server_generator/test/`) that generates from a small, purpose-built
"kitchen-sink" spec and actually *runs* the generated code (via Ktor's `testApplication`/
`MockEngine` test tooling), asserting on request/response behavior method-by-method, including
error paths - see [`generators/README.md`](../../generators/README.md). This directory's role
stays narrower and complementary to that: breadth across one real, large, messy third-party spec
plus a clean textbook one, checked for compile-success only. The per-generator `test/` directories
check depth - does every generated method actually behave correctly - on a small hand-designed
spec. Neither tier subsumes the other; run both when in doubt.
