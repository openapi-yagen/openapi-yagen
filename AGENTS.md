# AGENTS.md

Guidance for AI coding agents working in this repository. Read this before making changes — it
covers what the project is, how it's built, and conventions that aren't obvious from a quick
skim of the code.

## What this is

`openapi-yagen` ("yet another OpenAPI generator") is a C++20 CLI tool that generates source code
from an OpenAPI spec using pluggable, JavaScript-defined "generators" and Inja (Jinja-like)
templates. Users write generators (JS + `.j2` templates + a `generator.yml` descriptor), and the
tool drives spec parsing, JS execution, template rendering, file writing, and optional
post-processing (formatters/linters).

The full user-facing reference (CLI flags, generator format, built-in functions) lives in
`README.md` — read it for the "what", this file is the "how to work on it".

## Architecture

Entry point: `cli/main.cpp` → `cli/commands/generate_command.cpp` (`GenerateCommand`) wires
together the pieces below and calls `Generator::OpenApiGenerator::generate()`.

`lib/` is split into independent static libraries (see each `lib/*/CMakeLists.txt` for exact
sources/deps):

- `lib/common` — shared value type `Node` (a `std::variant`-based JSON/YAML-like tree, see
  `node.h`), `NodeWalker` for structured parsing, string helpers, functional-style STL pipe
  helpers (`std_tools.h`, e.g. `x | mapToVector(...)`, `x | firstOrThrow()`), YAML/JSON parsing.
- `lib/logger` — small logging facade (`Logger`, `LogLevel`) + console backend.
- `lib/filesystem` — abstracts reading generator files from a directory, a zip archive, or a
  remote HTTP(S) URL (`FileReaderBackend` implementations), plus output file writing and
  post-processing via external tools.
- `lib/js` — wraps QuickJS (`JS::Executor`) to run a generator's `main.js` as an ES module, with
  `tools.h/.cpp` converting between `Node` and `JSValue`.
- `lib/templates` — wraps Inja (`Templates::InjaTemplateRenderer`) for `.j2` template rendering.
- `lib/generator` — ties it together: `OpenApiGenerator::generate()` reads `generator.yml`
  (`generator_metadata.{h,cpp}`), reads the OpenAPI spec into a `Node`, executes `main.js` with
  globals injected (`schema`, `vars`, `renderTemplate`, `renderTemplateToString`, and the common
  functions in `functions.cpp`: `dump`, `toCamelCase`, `toPascalCase`, `toSnakeCase`,
  `toScreamingSnakeCase`).

`cli/` — CLI11-based argument parsing and command dispatch. `cli/config.h.in` is configured by
CMake with `APP_VERSION` (read from the first line of `CHANGELOG.md`).

`examples/simple_cpp_models_generator/` is a working example generator (used by
`examples/run.sh` and referenced by `test/`) — a good template to look at when writing or
debugging a generator, or when changing what globals/functions are exposed to `main.js`.

## Conventions

- **Error/log message tags**: nearly every `throw runtime_error(...)` and log call embeds a
  short random hex tag like `<88489c35>`, e.g. `throw runtime_error("<d6cb8e9c> Spec file not
  provided")`. These are unique per call site, used to grep a source location straight from a
  log/error message. When adding a new throw or log statement, add a new random 8-hex-digit tag
  in the same style (don't reuse an existing one, don't omit it).
- **Functional pipe style**: prefer the `|` helpers in `lib/common/std_tools.h` (`toVector()`,
  `mapToVector(...)`, `firstOrThrow()`, `toSet()`, etc.) over hand-written loops when transforming
  ranges, matching existing code.
- **`Node` as the universal value type**: OpenAPI spec data, generator variables, and JS↔C++
  values all pass through `Node` (`lib/common/node.h`), not `nlohmann::json` or similar. Convert
  at the JS boundary via `lib/js/tools.h` (`nodeToJSValue` / `jsValueToNode`).
- **Options structs**: components take a `struct Opts { ... }` by rvalue-ref constructor (e.g.
  `OpenApiGenerator::Opts`, `Executor::Opts`) rather than long parameter lists — follow this
  pattern for new components.
- **No exceptions across the JS boundary silently swallowed**: JS exceptions are rethrown as C++
  `runtime_error` via `checkForException`/`rethrowException` in `lib/js/tools.cpp`.
- Code style is enforced by `_clang-format` (WebKit-based, 120 col). Run `./reformat_sources.sh`
  before committing C++ changes (requires `clang-format` on PATH); it formats all `*.h`/`*.cpp`
  except `lib/3rdparty/*`.

## Building

Dependencies are managed via Conan 2 (`conanfile.txt`): termcolor, yaml-cpp, cli11, quickjs,
kuba-zip, inja, catch2. Requires CMake ≥ 3.5 and a C++20 compiler.

Local build:
```bash
conan profile detect --force   # first time only
conan install . --output-folder=build --build=missing
cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=build/conan_toolchain.cmake -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
```
The binary is `build/cli/openapi-yagen`. Build treats warnings as errors
(`-Wall -Wextra -Wpedantic -Werror`, see root `CMakeLists.txt`) — expect a clean build to fail on
any new warning.

Static, statically-linked release binaries (as shipped in `dist/` and CI) are built via Docker:
`./build-musl.sh` (musl/Alpine, x86_64 — output `dist/openapi-yagen`) and `./build-uclibc.sh`
(uClibc, x86, older glibc-free targets — output `dist/openapi-yagen-5`). These are what
`.github/workflows/build.yml` runs on every push and release on tag pushes.

## Testing

Tests use Catch2 3, in `test/` (`common_test.cpp`, `generator_test.cpp`, `parser_test.cpp`,
`vfs_test.cpp`), built as the `openapi-yagen-test` target alongside the main build. Test
resources (sample specs, generator files, a test zip) live in `test/resources/`.

```bash
cmake --build build -j --target openapi-yagen-test
./build/test/openapi-yagen-test
```

`generator_test.cpp` uses mocked `TemplateRenderer`/`FileReaderBackend` — follow that pattern
(don't hit the real filesystem or network) when adding tests for generator/JS-executor behavior.

Separately, `test/kotlin_generators/run_tests.sh` integration-tests the
`kotlin_ktor_client_generator`/`kotlin_ktor_server_generator` example generators end-to-end:
generate from a spec, then compile the output with `kotlinc`. It needs an external JVM/Kotlin/
Gradle toolchain the core project doesn't otherwise depend on, so it's not part of the CMake
build or CI — run it manually (see that directory's README for prerequisites).

## Trying it end-to-end

`examples/run.sh` runs the CLI against the example generator and the test petstore spec:
```bash
./build/cli/openapi-yagen g -o examples/out -g examples/simple_cpp_models_generator \
    -c test/resources/petstore.yaml -v "namespace=OpenAPI"
```
(the checked-in `examples/run.sh` assumes an installed `openapi-yagen` on PATH and
`clang-format` post-processing; adjust the path to your local build binary.)

## Docs upkeep

If you change the CLI options, the `generator.yml` schema, built-in JS/template functions, or
the globals exposed to `main.js`, update `README.md`'s corresponding reference section — it is
the user-facing source of truth and easily drifts from code. `README.md`'s `## TODO` section
tracks known gaps/planned features; check it before assuming something missing is an oversight
rather than planned work.
