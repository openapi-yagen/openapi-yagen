# Kotlin generator integration tests

Integration tests for `generators/kotlin_ktor_client_generator` and
`generators/kotlin_ktor_server_generator`: for both generators, against both a clean textbook spec
(`test/resources/petstore.yaml`) and a real-world one (`test/resources/ghes-subset.yaml`, a
curated subset of GitHub's own REST API spec), generate Kotlin source with `openapi-yagen` and
then compile it with `kotlinc`. A case only passes if both generation and compilation succeed.

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
lines) - too large to run wholesale, and it uses `oneOf`/`anyOf` far more often without a
discriminator than with one, which the generators don't support (a documented v1 limitation, see
each generator's README). `test/resources/ghes-subset.yaml` is a small, self-contained extract
(paths + their full transitive schema/parameter closure) containing only operations that are
fully compatible with the generators' current feature set, produced by
`extract_github_subset.py`. Re-run it if `ghes-3.15.yaml` changes or the generators gain support
for more spec features - see that script's docstring.
