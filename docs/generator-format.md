---
title: Generator format
sidebar_label: Generator format
slug: /docs/generator-format
description: Generator layout, metadata, loading, version conversion, overrides, and post-processing.
---

# Generator format

A generator is a folder of files, a zip archive, an HTTP(S) URL serving the same layout, or one of
the generators bundled into the `openapi-yagen` binary itself - `-g` accepts all four, resolved by
the same mechanism either way (see "Loading a generator" below). The structure is:

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

# The OpenAPI version this generator's main.js/templates are written to consume: "3.0", "3.1", or
# "3.2" (patch suffixes like "3.0.3" are accepted but not distinguished - see "Spec versions and
# conversion" below). Optional; defaults to "3.0" if omitted.
openApiVersion: "3.0"

# Variables that can be used to customize script execution
variables:
  - name: namespace
    description: С++ namespace for model classes
    required: false        # optional, defaults to false
    defaultValue: mymodels # optional; if omitted and not required, the variable is simply absent from `vars`
```

Reading a variable in JS: `vars.namespace` (see [`javascript-api.md`](javascript-api.md)'s
"Global values"). Setting it on the command line: `-v namespace=MyModels`.

Run `openapi-yagen info <generator>` to print a generator's declared variables (name,
required/optional, default, description) along with its name, description, and OpenAPI version,
without having to open its `generator.yml` by hand - see the root
[`README.md`](../README.md#cli-reference)'s `info` subcommand.

## Spec versions and conversion

The engine understands OpenAPI 3.0, 3.1, 3.2, and Swagger/OpenAPI 2.0 as *input*. Before running
your generator, it reads the input spec's own `openapi`/`swagger` field, compares it against your
generator's declared `openApiVersion`, and - if they differ - converts the spec to your declared
version first. Your `main.js`/templates always see a spec shaped like the version you declared,
regardless of what version the user's input spec actually was; you don't need to handle both
dialects yourself. This is what makes `kindOf`/a `.nullable` check/etc. behave consistently no
matter which version was fed in - see [`javascript-api.md`](javascript-api.md) for how `type`
and nullability show up in the `schema` object for the version you chose.

A generator's own `openApiVersion` may only be `"3.0"`, `"3.1"`, or `"3.2"` - never `"2.0"`. 2.0
works as an input spec (auto-converted up to whatever 3.x version you declare) and as an export
target for the standalone `convert` command below, but a generator's `main.js`/templates always see
an OAS 3.x-shaped `schema` object, so 2.0 can never be a generation target itself.

Conversion is scoped to what the engine's own model represents (schema `type`/`nullable`/format/
constraints/composition including the JSON Schema 2020-12 keywords OAS 3.1+ add, the standard
document/operation/parameter/response/security shape, and OAS 3.2's additions - `additionalOperations`,
the `query` operation, `$self`, richer tags (`summary`/`parent`/`kind`), streaming media types
(`itemSchema`), `discriminator.defaultMapping`, `XML.nodeType`, `Example.dataValue`/
`serializedValue`, and OAuth2's device authorization flow) - things the model doesn't cover at all
(vendor extensions aside, which always pass through untouched) are dropped when converting to a
version that has no equivalent (e.g. OAS 3.1's `webhooks` have nothing to convert to in 3.0; OAS
3.2's `additionalOperations` has nothing to convert to in 3.0 or 3.1). A security scheme's
`deprecated` flag is the one exception written back out rather than dropped: targeting a version
older than 3.2 folds it into the community `x-oai-deprecated` vendor extension, the documented
convention for that case. Converting up a version never loses anything, since every older
construct has a direct newer-version equivalent.

Swagger 2.0 predates several OAS 3.x constructs entirely, so both directions across that boundary
are lossy in places: reading 2.0, `host`/`basePath`/`schemes` synthesize a single `servers` entry,
`body`/`formData` parameters fold into `requestBody`, and the de-facto (not officially standardized,
but ubiquitous in tooling like Autorest/drf-yasg) `x-nullable` extension is read as canonical
nullability. Writing *to* 2.0, `oneOf`/`anyOf`/`not` and non-trivial `discriminator.mapping` have no
2.0 equivalent and are dropped (logged when this happens), `nullable` folds back into `x-nullable`,
and a `servers` entry with an unresolved `{variable}` placeholder can't become `host`/`basePath`/
`schemes` and is left unset rather than emitting a misleading literal host. A generator itself may
never target 2.0 (see above) - this direction only matters for the standalone `convert` command.

This conversion also doubles as the spec's structural validation: reading the spec into the
engine's typed model requires the fields the specification itself requires (`openapi`, `info.title`,
`info.version`, `parameter.name`/`in`, ...), so a malformed spec fails fast with a clear error
naming the missing/misshapen field - there's no separate JSON-schema validation step to configure.
This isn't as exhaustive as a full JSON-Schema-meta-schema validator (it won't, for instance, catch
an invalid `parameter.in` enum value or a malformed `pattern` regex) - it validates the shape the
engine's model actually covers.

The same conversion is available as a standalone command, independent of any generator - see the
root [`README.md`](../README.md#cli-reference)'s `convert` subcommand, e.g. to pin a spec to one
version before checking it in, or to inspect what a 3.1 spec looks like once folded down to 3.0.

## Loading a generator

`-g` accepts:
1. **`builtin:<name>`** - one of the generators embedded directly into the `openapi-yagen` binary
   at compile time (currently `kotlin_ktor_client`, `kotlin_ktor_server`, and
   `typescript_fetch_client` - run `openapi-yagen list-generators` for the current list with
   descriptions). Works with no local checkout, network access, or filesystem at all. Use
   `openapi-yagen extract <name> -o <dir>` to write a built-in generator's files out to disk, e.g.
   to fork/customize one without starting from scratch.
2. **A directory** - the common case during development. Relative paths are resolved against the
   current working directory.
3. **A zip archive** - the same folder layout, zipped.
4. **An HTTP(S) URL** - the same folder layout, served over HTTP/S (e.g. directly from a GitHub
   raw-content URL). Requires the `curl` tool to be installed.

These four are mutually exclusive by construction (a `builtin:`-prefixed string can never be a real
directory/zip/URL), so there's no real "priority" contest between them in practice.

`--override-dir <dir>` layers an extra directory *on top* of the generator, checked first - any
file present there (e.g. a template you want to tweak without forking the whole generator) wins
over the generator's own copy. Useful for local experimentation against a generator you don't want
to modify directly - including a `builtin:` one.

## Full CLI reference

See the root [`README.md`](../README.md#cli-reference) for the complete `generate`/`g` subcommand
reference (all flags, including `-o/--out-dir` and `-c/--clear` which aren't specific to writing a
generator) and the `convert` subcommand (standalone spec version conversion).
