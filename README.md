<p align="center">
  <img src="openapi-yagen.png" alt="openapi-yagen logo" width="150">
</p>

# Yet another OpenAPI generator (openapi-yagen)

Main features:

- a small generator core written in C++
- specific generators are written in JavaScript with support for ES2023 features ([QuickJS](https://bellard.org/quickjs/))
  and [Inja](https://pantor.github.io/inja/) templates (like Jinja)
- extending templates with additional functions defined in JS
- possibility to extend existing generators by overriding some files from a specified directory
- post-processing of output files using custom tools (code formatters, linters, checkers...)
- using generators available via HTTP/S (directly from GitHub, or other sources). The `curl` tool is required.

## Installation

Statically-linked binaries for Linux (x86_64) are published on the
[releases page](https://github.com/openapi-yagen/openapi-yagen/releases). Install the latest
release to `/usr/local/bin` with:

```bash
sudo curl -L https://github.com/openapi-yagen/openapi-yagen/releases/latest/download/openapi-yagen -o /usr/local/bin/openapi-yagen && sudo chmod +x /usr/local/bin/openapi-yagen
```

## CLI reference

Supported CLI root options and subcommands:
```
Usage: ./openapi-yagen [OPTIONS] [SUBCOMMAND]

Options:
  -h,--help                   Print this help message and exit

Subcommands:
  generate, g                 Generate sources from openapi specification
```

Generate subcommand:

```
Generate sources from openapi specification
Usage: ./openapi-yagen generate [OPTIONS] [spec-file]

Positionals:
  spec-file TEXT [openapi.yaml] 
                              Specification file

Options:
  -h,--help                   Print this help message and exit
  --override-dir TEXT         Directory with overridden generator files
  -o,--out-dir TEXT [.]       Output directory for generated code
  -g,--generator TEXT REQUIRED
                              Path to generator. It can be directory, zip archive or HTTP URL
  -p,--post-process TEXT ...  Post process file with specified tool for extension
  -c,--clear                  Clear output directory before generating
  -v,--var TEXT ...           Set variable. Syntax is: -v (var_name)=(var_value)
```

## Writing a generator

See [`docs/`](docs/README.md) for the full generator-writing documentation: a step-by-step
[tutorial](docs/tutorial.md) building a small generator from scratch, the
[generator format](docs/generator-format.md) (folder layout, `generator.yml`), the
[JavaScript API](docs/javascript-api.md) (globals, built-in functions), and
[templating](docs/templating.md) (Inja syntax, calling functions from templates).

## Generators

Generators are located in the `generators` folder:

- [`sample_cpp_models_generator`](generators/sample_cpp_models_generator/README.md) - minimal
  example generating C++ model structs from schemas.
- [`kotlin_ktor_client_generator`](generators/kotlin_ktor_client_generator/README.md) - Kotlin
  Multiplatform API client for [Ktor](https://ktor.io), engine-agnostic (works on JVM, Android,
  iOS/Native, JS, Wasm).
- [`kotlin_ktor_server_generator`](generators/kotlin_ktor_server_generator/README.md) - Ktor server
  routing + a handler interface you implement, with request validation.

## Development

The project is a CMake + Conan 2 C++20 codebase (core in `lib/`, CLI in `cli/`, tests in
`test/`). See [AGENTS.md](AGENTS.md) for build/test commands, project architecture, and coding
conventions - it's the entry point for working on the `openapi-yagen` engine itself (as opposed to
writing a generator, which [`docs/`](docs/README.md) covers).

## TODO

- [x] Add schema validation with JSON schema (conan: json-schema-validator/2.3.0)
- [x] Add configuration variables
- [x] Improve documentation and add more examples
- [ ] Use https://github.com/batterycenter/embed to embed some popular templates into binary
- [x] Add remote templates reading (from GitHub for example)
- [ ] Command to create generator stub
- [ ] Command to show available variables for generator
- [ ] Restrict access to files outside working folder
