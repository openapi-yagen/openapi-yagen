# Generator format

A generator is a folder of files, a zip archive, or an HTTP(S) URL serving the same layout - `-g`
accepts all three, resolved by the same mechanism either way (see "Loading a generator" below).
The structure is:

- `generator.yml` - generator metadata, descriptor
- `main.js` - main JavaScript file (entrypoint)
- other resources - Inja templates, other JS files imported into `main.js`

Example:
```
├── generator.yml
├── head.h.j2
├── includes.h.j2
├── main.js
└── model.h.j2
```

This is the engine's entire contract - any directory shaped like this works with `-g`, wherever it
lives. Every path a generator references (`generator.yml`, `main.js`, templates, `copyFile`
sources, even the ES-module imports inside `main.js`) is resolved strictly relative to whatever
root `-g` points at. Nothing assumes a generator lives in any particular place on disk.

This repo's own `generators/` collection additionally nests that payload one level down, under
each generator's own `src/`, alongside a `README.md` and an optional `test/` - see
[`generators/README.md`](../generators/README.md) for that convention. It's a convention specific
to this repo's example collection, not a requirement of the format described here.

## `generator.yml`

A descriptor of the generator. Example file with comments:

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
    required: false        # optional, defaults to false
    defaultValue: mymodels # optional; if omitted and not required, the variable is simply absent from `vars`
```

Reading a variable in JS: `vars.namespace` (see [`javascript-api.md`](javascript-api.md)'s
"Global values"). Setting it on the command line: `-v namespace=MyModels`.

## Loading a generator

`-g` accepts, in this priority order:
1. **A directory** - the common case during development. Relative paths are resolved against the
   current working directory.
2. **A zip archive** - the same folder layout, zipped.
3. **An HTTP(S) URL** - the same folder layout, served over HTTP/S (e.g. directly from a GitHub
   raw-content URL). Requires the `curl` tool to be installed.

`--override-dir <dir>` layers an extra directory *on top* of the generator, checked first - any
file present there (e.g. a template you want to tweak without forking the whole generator) wins
over the generator's own copy. Useful for local experimentation against a generator you don't want
to modify directly.

## Post-processing generated files

`-p/--post-process <spec>` runs an external command on each generated file, keyed by extension:

```
-p "ts:prettier --write %file%"
```

`%file%` is replaced with the generated file's path. The `ext1,ext2:` prefix is optional - a
`-p` value with no prefix (just a bare command) runs on *every* generated file, regardless of
extension. Pass `-p` more than once to chain multiple tools (e.g. one for `.kt` files, a different
one for everything else).

## Full CLI reference

See the root [`README.md`](../README.md#cli-reference) for the complete `generate`/`g` subcommand
reference (all flags, including `-o/--out-dir` and `-c/--clear` which aren't specific to writing a
generator).
