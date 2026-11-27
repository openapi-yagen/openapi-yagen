# Building

Dependencies are managed via Conan 2 (`conanfile.txt`): termcolor, yaml-cpp, cli11, quickjs,
kuba-zip, catch2, nlohmann_json, battery-embed (embeds the built-in generators, see
`lib/filesystem/`'s `EMBEDDED_GENERATOR_DIRS`). Inja itself is vendored, not a Conan dependency -
see `lib/3rdparty/inja/NOTICE.md`. Requires CMake ≥ 3.21 and a C++20 compiler (both driven by
battery-embed's own floor).

Local build:
```bash
conan profile detect --force   # first time only
conan install . -s compiler.cppstd=20 --output-folder=build --build=missing
cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=build/conan_toolchain.cmake -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
```
`-s compiler.cppstd=20` is required - `conan profile detect`'s auto-detected default profile
picks a `gnu17`-style value that satisfies the project's own `CMAKE_CXX_STANDARD 20` toolchain
setting at the compiler-flag level, but doesn't satisfy battery-embed's own Conan-recipe-level
minimum-cppstd package validation, so `conan install` fails with `Invalid: Current cppstd (gnu17)
is lower than the required C++ standard (20)` without it. `conanfile.txt` can't declare this
itself (no `[settings]` section is valid there), so it's passed on every `conan install`
invocation instead (also updated in `Dockerfile.musl`, `Dockerfile.uclibc`, and
`.github/workflows/build.yml`'s `kotlin-native-compile-check` job).
The binary is `build/cli/openapi-yagen`. Build treats warnings as errors
(`-Wall -Wextra -Wpedantic -Werror`, see root `CMakeLists.txt`) — expect a clean build to fail on
any new warning.

clang-tidy runs on every compiled source as part of the build (`ENABLE_CLANG_TIDY`, on by
default) with the checks from `.clang-tidy` - uninitialized class fields and local variables -
and any finding is an error. Initialize every scalar/pointer field and local at its declaration,
even one only filled via an out-parameter. Where `clang-tidy` isn't installed (the Docker and
macOS release builds) the step is skipped with a CMake warning; `-DENABLE_CLANG_TIDY=OFF` turns
it off explicitly. It roughly doubles full-rebuild time.

`BUILD_TESTS` (on by default) adds the Catch2 test binary (`test/`). The release builds
(`Dockerfile.musl`, `Dockerfile.uclibc`, `Dockerfile.wasm`, `build-macos.sh`) pass
`-DBUILD_TESTS=OFF` so they don't compile tests they never run; keep that flag on any new
release/distribution build script.

## kuba-zip source checksum

The ConanCenter recipe of `kuba-zip/0.3.2` carries a sha256 that GitHub's current source archive no
longer matches (the files inside are unchanged), so building the package from source fails with
`sha256 hash failed`. `scripts/pin-kuba-zip-checksum.sh` replaces the sha256 in the cached recipe;
the Dockerfiles run it in the same `RUN` as `conan install` (a cache mount can be emptied between
steps), and `build-macos.sh` runs it too. Run it by hand if a local `conan install` hits the error.
If GitHub's archive changes again, compare its files with a previously verified copy before
updating the sha256. Remove the script once
[conan-center-index#31536](https://github.com/conan-io/conan-center-index/issues/31536) is fixed.

## Release binaries

Static, statically-linked release binaries (as shipped in `dist/` and CI) are built via Docker:
`./build-musl.sh` (musl/Alpine, x86_64 — output `dist/openapi-yagen`) and `./build-uclibc.sh`
(uClibc, x86, older glibc-free targets — output `dist/openapi-yagen-5`). These are what
`.github/workflows/build.yml` runs (build + upload artifact) on pull requests targeting `master`
and on semver tag pushes, publishing a GitHub Release only for the latter.

## Docker build caching

Both Dockerfiles cache Conan's package cache (`/root/.conan2`) via a BuildKit `RUN
--mount=type=cache` (needs `# syntax=docker/dockerfile:1` as the file's first line). A cache mount
is **not** part of the committed image layer - it only exists for the duration of the `RUN` that
mounts it - so every `RUN` that needs anything under `/root/.conan2` (`conan profile detect`,
`conan install`, and the final `cmake`/build step, which links against libraries living in the
Conan package cache) must mount it, or it'll see an empty/incomplete dir and fail (e.g. "Library
'yaml-cpp' not found in package"). `build-musl.sh`/`build-uclibc.sh` build with `docker buildx
build --load ${DOCKER_BUILDX_ARGS:-}` - CI sets `DOCKER_BUILDX_ARGS` to add
`--cache-from/--cache-to type=gha` (via `docker/setup-buildx-action`) so the whole `conan install`
layer is reused across runs too; locally the var is just unset/empty.
