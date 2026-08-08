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

## Spec versions and conversion

The engine understands OpenAPI 3.0, 3.1, and 3.2 (Swagger/OpenAPI 2.0 isn't supported yet). Before
running your generator, it reads the input spec's own `openapi:` field, compares it against your
generator's declared `openApiVersion`, and - if they differ - converts the spec to your declared
version first. Your `main.js`/templates always see a spec shaped like the version you declared,
regardless of what version the user's input spec actually was; you don't need to handle both
dialects yourself. This is what makes `kindOf`/a `.nullable` check/etc. behave consistently no
matter which version was fed in - see [`javascript-api.md`](javascript-api.md) for how `type`
and nullability show up in the `schema` object for the version you chose.

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
generator) and the `convert` subcommand (standalone spec version conversion).
