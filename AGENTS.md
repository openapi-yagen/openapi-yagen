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
- `lib/openapi` — a version-agnostic canonical OpenAPI object model (`Document`/`Schema`/... in
  `document.h`/`schema.h`/`info.h`/`security.h`) plus per-version-family readers/writers that
  convert a raw `Node` to/from it: `v3/` (`reader.cpp`/`writer.cpp`) covers OpenAPI 3.0/3.1/3.2 as
  one family (they differ only in a handful of fields/dialect quirks), `v2/` covers Swagger/OpenAPI
  2.0 separately since it's a structurally different format (`host`/`basePath`/`schemes` instead of
  `servers`, `definitions` instead of `components.schemas`, body/formData parameters instead of
  `requestBody`, ...). `version_convert.cpp`'s `convertVersion(node, from, to)` composes
  `<family>::Read` + `<family>::Write` to convert between any two supported versions via this IR as
  the hub; `resolve.cpp` resolves every `$ref` in the raw `Node` tree (not the typed model) before
  it reaches `lib/generator`. Reading a spec into the typed model also doubles as its structural
  validation - a malformed spec fails fast with a clear error naming the missing/misshapen field,
  no separate JSON-schema validation step. See
  [`docs/generator-format.md`](docs/generator-format.md#spec-versions-and-conversion) for the
  user-facing version/conversion behavior this enables.
- `lib/generator` — ties it together: `OpenApiGenerator::generate()` reads `generator.yml`
  (`generator_metadata.{h,cpp}`), reads the OpenAPI spec into a `Node`, converts it to the
  generator's declared `openApiVersion` if needed (`convertToGeneratorVersion`, via `lib/openapi`),
  resolves all `$ref`s, and executes `main.js` with globals injected (`schema`, `vars`,
  `renderTemplate`, `renderTemplateToString`, and the common functions in `functions.cpp`: `dump`,
  `toCamelCase`, `toPascalCase`, `toSnakeCase`, `toScreamingSnakeCase`) via
  `openapi_js_bridge.{h,cpp}`'s raw-passthrough + typed-field overlay pattern. A generator's
  `openApiVersion` may only resolve to 3.0/3.1/3.2 - 2.0 works only as a spec *input* (converted up
  before reaching the JS bridge), never as a generation target, since the bridge's raw shape
  assumes OAS 3.x (content maps, nested `schema` keys, ...).

`cli/` — CLI11-based argument parsing and command dispatch: `generate`/`g`
(`commands/generate_command.cpp`) runs the pipeline above, `convert` (`commands/convert_command.cpp`)
exposes `OpenApi::convertVersion` standalone, independent of any generator. `cli/config.h.in` is
configured by
CMake with `APP_VERSION`, taken from `git describe --tags --always` (root `CMakeLists.txt`): an
exact tag reads as `1.2.3`, N commits past a tag as `1.2.3-N-gHASH`. Requires the build's checkout
to have full history and tags fetched (see `.github/workflows/build.yml`'s `fetch-depth: 0`) and
`git` available on `PATH` at configure time (the musl/uClibc Docker build images install it) -
falls back to `"unknown"` if git or a repo isn't found. Exposed on the CLI via `-v/--version`
(`CLI::App::set_version_flag` in `cli/main.cpp`) and in the `--help` banner.

`generators/sample_cpp_models_generator/` is a working example generator (used by
`generators/run.sh` and referenced by `test/`) — a good template to look at when writing or
debugging a generator, or when changing what globals/functions are exposed to `main.js`.

## Conventions

- **Error/log message tags**: nearly every `throw runtime_error(...)` and log call embeds a
  short random hex tag like `<88489c35>`, e.g. `throw runtime_error("<d6cb8e9c> Spec file not
  provided")`. These are unique per call site, used to grep a source location straight from a
  log/error message. When adding a new throw or log statement, add a new 8-hex-digit tag in the
  same style (don't reuse an existing one, don't omit it) - generated by **actually running a
  random-generator command** (e.g. `openssl rand -hex 4`, or Python's `secrets.token_hex(4)`) and
  pasting its literal output. Never hand-type/compose a hex string yourself, even one meant to
  "look random" - a whole batch of this project's tags turned out to be visibly sequential
  (`a1b2c3d4`, `b2c3d4e5`, `c3d4e5f6`, ...) or the same value copy-pasted across unrelated call
  sites, because they'd been typed rather than actually generated. Before using a newly-generated
  tag, grep for it to confirm it doesn't already exist anywhere in the codebase.
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
- **Every generator must thread OpenAPI `description` into generated doc comments** (KDoc/TSDoc/
  Doxygen `///`, whatever the target language uses) - not just capture it into the JS-side model
  and drop it before rendering. This covers: the model/class itself (schema `description`), each
  field/property, each generated operation/method (`operation.summary` **and** `operation.description`
  - both, not just `summary`; a longer `description` is common and gets silently dropped if only
  `summary` is wired up), each parameter (as `@param`-style lines where the target language's doc
  convention supports it), and - easy to miss entirely, since nothing else in the engine reads it -
  the API class/interface itself, sourced from the document's top-level `tags: [{name, description}]`
  array (`schema.tags` in JS - distinct from `op.tags`, which only lists tag *names* on an
  operation). If the generator also emits a single bundle/facade class that aggregates one
  instance of every tag's class (e.g. a client generator's top-level `ApiClient`, constructed once
  from shared config), that bundle class gets its own doc comment too, sourced from the document's
  top-level `info.description` (`schema.info.description` in JS) - distinct again from any one
  tag's description, since the bundle represents the whole API. Each *property* on that bundle
  class (one per tag) also needs its own doc comment - the same tag description already shown on
  the class it points to, not left bare just because the class itself is already documented. See
  `kotlin_ktor_client_generator`/`kotlin_ktor_server_generator`/
  `typescript_fetch_client_generator`'s `lib/operations.js` (`buildDocLines`/`tagDescription`) and
  their model templates for the reference implementation - when adding a new generator or
  reworking an existing one's templates, verify all of the above still holds, not just that the
  code compiles/runs.

## Building

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

Static, statically-linked release binaries (as shipped in `dist/` and CI) are built via Docker:
`./build-musl.sh` (musl/Alpine, x86_64 — output `dist/openapi-yagen`) and `./build-uclibc.sh`
(uClibc, x86, older glibc-free targets — output `dist/openapi-yagen-5`). These are what
`.github/workflows/build.yml` runs (build + upload artifact) on pull requests targeting `master`
and on semver tag pushes, publishing a GitHub Release only for the latter.

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

## Testing

Tests use Catch2 3, in `test/` (`common_test.cpp`, `generator_test.cpp`, `openapi_js_test.cpp`,
`openapi_test.cpp`, `parser_test.cpp`, `v2_reader_writer_test.cpp`, `v3_reader_writer_test.cpp`,
`vfs_test.cpp`), built as the `openapi-yagen-test` target alongside the main build. Test
resources (sample specs, generator files, a test zip) live in `test/resources/`.

```bash
cmake --build build -j --target openapi-yagen-test
./build/test/openapi-yagen-test
```

`generator_test.cpp` uses mocked `TemplateRenderer`/`FileReaderBackend` — follow that pattern
(don't hit the real filesystem or network) when adding tests for generator/JS-executor behavior.

Each generator is also a self-contained subproject under `generators/<name>/` — `README.md` +
`src/` (everything `-g` points at) + `test/` (that generator's own runtime test suite, if it has
one). `kotlin_ktor_client_generator/test/` and `kotlin_ktor_server_generator/test/` are
independent Kotlin Multiplatform (`jvm()` + `linuxX64()`) Gradle projects that regenerate from
their own kitchen-sink spec: `./gradlew test` (aliased to `jvmTest`) actually runs the generated
code under JUnit5 (`testApplication`/`MockEngine`), not just compiles it, while
`./gradlew compileKotlinLinuxX64` proves the same generated code also compiles under Kotlin/Native
(checked in CI - `.github/workflows/build.yml`'s `kotlin-native-compile-check` job) - see
`generators/README.md` for the convention and how to run one in isolation.

## Trying it end-to-end

`generators/run.sh` runs the CLI against the example generator and the test petstore spec:
```bash
./build/cli/openapi-yagen g -o generators/out -g generators/sample_cpp_models_generator/src \
    -c test/resources/petstore.yaml -v "namespace=OpenAPI"
```
(the checked-in `generators/run.sh` assumes an installed `openapi-yagen` on PATH and
`clang-format` post-processing; adjust the path to your local build binary.)

## Docs upkeep

If you change the CLI options, update `README.md`'s "CLI reference" section. If you change the
`generator.yml` schema, built-in JS/template functions, or the globals exposed to `main.js`, update
the corresponding page under [`docs/`](docs/README.md) instead - that's the user-facing source of
truth for writing a generator and easily drifts from code. `README.md`'s `## TODO` section tracks
known gaps/planned features; check it before assuming something missing is an oversight rather
than planned work.

Internal analysis/planning write-ups (design tradeoffs, a backlog item's own "why" and acceptance
criteria, anything meant for whoever picks the work back up rather than for someone writing a
generator) go under `docs/planning/`, not directly under `docs/`: the website's `include` list
(`website/docusaurus.config.ts`) only globs `docs/*.md` - not recursive - so a `docs/planning/*.md`
file never reaches the published site. `TODO-improvements.md` at the repo root is the running
backlog these documents typically feed into.

### "Tidy up CHANGELOG"

When asked to tidy up `CHANGELOG.md`, edit
only the section for commits since the last tagged release (`git tag -l`) - typically the topmost,
still-unreleased heading. For each commit message in that section:

- Drop entries with no interest to `openapi-yagen` users: routine `README` touch-ups, internal
  test/CI/build-tooling churn (test project restructuring, Docker base image bumps, Gradle
  wrappers), typo fixes, reverted/rolled-back intermediate steps, and other commits that don't
  change a user- or generator-author-visible behavior, built-in, or CLI flag.
- Refactors and source-tree reorganizations (moving files, renaming internal folders, splitting
  modules) are not interesting to users on their own - drop them. Only mention one if it changes a
  path/name a user actually passes on the command line (e.g. a renamed generator directory).
- Rephrase entries that describe an internal implementation step (a class name, a file path, "lib/
  ...") into a plain description of the resulting user-visible capability.
- Consolidate a run of incremental commits that build up one feature (e.g. a series of "Add X",
  "Extend X", "Document X" commits landing one JS API) into a single bullet describing the
  feature's end state, rather than listing every step.
- Multiple commits touching the same generator or component (e.g. several separate commits about
  the Kotlin generators) collapse into one bullet naming that generator/component once, not one
  bullet per commit.
- Keep bug fixes, new CLI/generator-author-facing features, new built-ins, new example generators,
  and install/release process changes - these are what users read the changelog for. But still aim
  to leave only what matters most: fold minor/low-signal entries into a closely related bullet
  instead of listing them on their own, rather than keeping every commit as a separate line.

Preserve the existing formatting: one version heading per release (`# <semver> (<date>)`, matching
`APP_VERSION`'s source - see "Architecture" above), one `- ` bullet per entry. Do not touch
already-released version sections.

Order the entries in three groups, in this order: new features first, then changes to existing
behavior (including docs/process changes), then bug fixes last. Within each group, keep entries in
newest-first order (their original relative order).
