# Yet another OpenAPI generator (openapi-yagen)

Main features:

- a small generator core written in C++
- specific generators are written in JavaScript with support of ES2023 features ([QuickJS](https://bellard.org/quickjs/)) 
  and [Inja](https://pantor.github.io/inja/) templates (like Jinja)
- extending templates with additional functions defined in JS
- possibility to extend existing generators by overriding some files from a specified directory
- postprocessing of output files using custom tools (code formatters, linters, checkers...).
- using generators available via HTTP/S (directly from Github, or other sources). The `curl` tool is required.

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

## Generator reference

The generator is a folder of files or a zip archive. The structure of the generator files is as follows:

- `generator.yml` - generator metadata, descriptor
- `main.js` - main JavaScript file
- other resoucres - Inja templates, other JS files imported into `main.js`

Example: 
```
├── generator.yml
├── head.h.j2
├── includes.h.j2
├── main.js
└── model.h.j2
```

The file `generator.yml` is a descriptor of the generator. This is a example file with comments:

```yaml
# Generator name
name: sample_cpp_models

# Generator description
description: Example of C++ model generator from OpenAPI v3 specification

# Main JavaScript file (entrypoint).
mainScriptPath: main.js

# Json schema for input data validation. Point this at the official OpenAPI schema for the
# exact version(s) your generator supports (e.g. the OpenAPI 3.0 or 3.1 meta-schema) - the engine
# has no separate/hardcoded version check of its own, and the official schemas already pin the
# "openapi" field itself (e.g. `^3\.0\.\d(-.+)?$`), so an unsupported spec version is rejected as
# part of this same validation, with no extra mechanism needed.
jsonSchemaPath: openapi_v3_schema.json

# Variables that can be used to customize script execution
variables:
  - name: namespace
    description: С++ namespace for model classes
```

### Common built-in functions

These functions are available in both JavaScript and template code.

#### dump

Dumps specified values to log output. It is a replacement for `console.log`.

```typescript
dump(...args: any)
```

#### toCamelCase, toPascalCase, toSnakeCase, toScreamingSnakeCase

Converts string identifier from any case convention to specified case convention.

```typescript
toCamelCase(s: string): string // -> camelCase
toPascalCase(s: string): string // -> PascalCase
toSnakeCase(s: string): string // -> snake_case
toScreamingSnakeCase(s: string): string // SCREAMING_SNAKE_CASE
```

#### isValidIdentifier, sanitizeIdentifier

`isValidIdentifier` checks whether a string is already a valid identifier in any C-like language
(starts with a letter/underscore, followed by letters/digits/underscores - no keyword check, since
that's language-specific). `sanitizeIdentifier` turns an arbitrary string into one by replacing
every other character with `_` and prefixing `_` if the result would start with a digit or be
empty. Neither case-converts or escapes target-language keywords - combine with
`toCamelCase`/`toPascalCase`/... and your own keyword list as needed.

```typescript
isValidIdentifier(s: string): boolean
sanitizeIdentifier(s: string): string // e.g. "pet/status" -> "pet_status", "2fa" -> "_2fa"
```

## JavaScript reference

The generator core supports all modern JavaScript features from ES2023 (string interpolation, classes, let, const, 
modules ...) thanks to QuickJS. 

### Global values

These global values are available in the main script (and anything it imports):

- `schema` - the parsed OpenAPI specification (contents of the `spec-file`), mirroring the
  original document 1:1 (every field, including vendor/`x-*` extensions, unchanged) with exactly
  one difference: every `$ref` is replaced by the actual object it points to. A schema reached
  through two different `$ref`s (or a self-referential one) is the *same* JS object (`===`), not a
  copy - so cyclic types work, but it also means you should never pass a piece of `schema` directly
  as `renderTemplate`'s `data` if it might be cyclic (see `renderTemplate` below); use `schema` for
  navigation and build a fresh plain object per render instead.
- `vars` - an object with the resolved generator variables (see `-v`/`--var` and the `variables`
  section of `generator.yml`), keyed by variable name

```js
renderTemplate("model.h.j2", { schemas: schema.components.schemas, namespace: vars.namespace }, "model.h");
```

### Built-in functions

#### kindOf, constraintsOf, nameOf, collectOperations

Since `$ref` is already resolved on `schema`, these save you from re-deriving the bookkeeping every
generator otherwise needs: classifying a schema's shape, extracting its validation keywords,
recovering the name a resolved schema/parameter/requestBody/response was reached through (there's
no `$ref` string to read anymore), and merging path-level + operation-level parameters.

```typescript
kindOf(schema: object): "Object" | "Array" | "Enum" | "AllOf" | "OneOf" | "AnyOf" | "Map" | "Primitive" | "Unknown"
constraintsOf(schema: object): { minimum?, maximum?, minLength?, maxLength?, minItems?, maxItems?, pattern?, uniqueItems? }
nameOf(x: object): string | null // null if x is an inline/anonymous definition, never reached via $ref
collectOperations(): Operation[] // { method, path, operationId, summary, description, tags, parameters, requestBody, responses }
```

```js
for (const [name, s] of Object.entries(schema.components.schemas)) {
  if (kindOf(s) === "Object") { /* ... */ }
}
for (const op of collectOperations()) {
  const responseSchema = op.responses["200"]?.content?.["application/json"]?.schema;
  const typeName = responseSchema && nameOf(responseSchema); // null -> anonymous/inline type
}
```

#### renderTemplate

Renders specified template (`templateFilePath`) in generator folder into `outFilePath` with provided `data` object. 
Additionally, you can pass a set of JS defined functions (`functions`) that will be available for use in the templates.

`data` must not contain a circular reference - build a fresh, per-render plain object from
whatever part of `schema` you need (e.g. represent a self-referential property as `{ name, type:
"TreeNode" }`, a reference by name, rather than passing the nested schema object itself).

```typescript
renderTemplate(
    templateFilePath: string, 
    data: { [key: string]: any }, 
    outFilePath: string,
    functions?: { [name: string]: Function }
): void
```

#### renderTemplateToString

Renders specified template (`templateFilePath`) in generator folder into string with provided `data` object. 
Additionally, you can pass a set of JS defined functions (`functions`) that will be available for use in the templates.

```typescript
renderTemplateToString(
    templateFilePath: string, 
    data: { [key: string]: any }, 
    functions?: { [name: string]: Function }
): string
```

## Templating reference

`Inja` is used as the template rendering engine. The main documentation can be found here
https://pantor.github.io/inja/

You can call common built-in functions described above in this way:

```jinja
{% set value = toSnakeCase("FirstSecondThird") %}
{{ dump(value) }}
```

## Example generators 

Example generators are located in the `generators` folder:

- `simple_cpp_models_generator` - minimal example generating C++ model structs from schemas.
- [`kotlin_ktor_client_generator`](generators/kotlin_ktor_client_generator/README.md) - Kotlin
  Multiplatform API client for [Ktor](https://ktor.io), engine-agnostic (works on JVM, Android,
  iOS/Native, JS, Wasm).
- [`kotlin_ktor_server_generator`](generators/kotlin_ktor_server_generator/README.md) - Ktor server
  routing + a handler interface you implement, with request validation.

## Development

The project is a CMake + Conan 2 C++20 codebase (core in `lib/`, CLI in `cli/`, tests in
`test/`). See [AGENTS.md](AGENTS.md) for build/test commands, project architecture, and coding
conventions - it's the entry point for working on the generator itself (as opposed to writing a
generator, which the rest of this README covers).

## TODO

- [x] Add schema validation with JSON schema (conan: json-schema-validator/2.3.0)
- [x] Add configuration variables
- [ ] Improve documentation and add more examples
- [ ] Use https://github.com/batterycenter/embed to embed some popular templates into binary
- [x] Add remote templates reading (from github for example)
- [ ] Command to create generator stub
- [ ] Command to show available variables for generator
- [ ] Restrict access to files outside working folder
