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

# Overrides which comment style the engine wraps the auto-generated "do not edit" header in (see
# the root README.md's "Auto-generated file headers") for every file THIS generator writes via
# renderTemplate/copyFile - regardless of the file's own extension. One of "/** */", "//", "///",
# or "#" (the same four styles buildDocComment accepts - see javascript-api.md). Optional; if
# omitted, the engine picks a style from the output file's own extension instead (falling back to
# no header at all for an extension it doesn't recognize). Only worth setting when your generator
# emits an extension the built-in table guesses wrong for.
commentStyle: "//"

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

## External $ref resolution

Before your generator ever sees it, the engine bundles a multi-file spec into one document: every
**external** `$ref` (one pointing at another file, as opposed to an in-document `#/...` pointer) is
resolved, so your generator always sees a single, already-merged document.

### Which files can be read

- A `$ref` path is relative to the file it's written in. `../` is fine as long as the target stays
  inside the **ref root** - by default the directory of the spec file you pass, or the directory
  given with `--ref-root <dir>` (needed, for example, when the spec refers to a sibling directory).
  Symlinks leading outside it don't count as inside.
- Remote (`http://`, `https://`) refs aren't supported.
- Any `$ref` that can't be resolved - missing file, outside the ref root, missing `#/...` fragment,
  a cycle that can't be represented - is an error: the command exits with a non-zero code and names
  the `$ref`, the file and place it's written at, and the reason.

### Where the referenced content ends up

- A **component** of another file (`other.yaml#/components/<section>/<Name>`, or
  `#/definitions/<Name>`) is copied into the same section of the resulting document under the same
  name, and the `$ref` becomes `#/components/<section>/<Name>`. Only what's reachable through refs
  (including `discriminator.mapping`) is copied - the rest of that file is ignored.
- A `$ref` placed directly in one of your own components (`components.schemas.Pet: {$ref:
  'pet.yaml'}`) *defines* that component: other refs to the same target use the name `Pet`.
- Two files providing a component with the **same name** end up as one component if the content is
  identical; if it differs, that's an error naming both sources.
- A **Path Item** (under `paths`, `webhooks`, `callbacks`) is inlined as a whole, including its
  path-level `parameters`; keys written next to the `$ref` (such as `summary`) are added to it.
  The same goes for `#/components/pathItems/<Name>`.
- Anything referenced by a pointer **outside of components** - a whole file, `#/paths/~1items`,
  `#/some/key` - is inlined at the place of the `$ref`. Some real-world specs (DigitalOcean's public
  API source, for one) use `$ref` in positions OpenAPI doesn't allow (`tags[].description`, a whole
  Operation standing in for `get:`/`post:`/...); these are spliced in on a best-effort basis.
- A `#/...` ref written *inside* another file means "the root of that file". If it doesn't point
  at a component (e.g. a recursive schema referring to `#/node` in a shared file), the fragment
  becomes a schema component named after the pointer's last segment.
- `#/...` refs written in your root spec are left as they are.

### Operations taken from another API

When operations come from a file that is a complete OpenAPI document (it has its own `openapi` or
`swagger` field), they keep what that document says about them:

- an operation without its own `security` gets that document's global `security` (or `[]` if there
  is none), so your root spec's global `security` doesn't apply to it;
- the security schemes those requirements name are copied into `components.securitySchemes`;
- the descriptions of their tags are added to the top-level `tags`, unless your spec already
  declares a tag with that name.

A file without that field is a plain fragment: your root spec's `security` applies to the
operations taken from it.

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

## `servers`/`basePath` is never read by a generator

Every operation's own path (a `paths:` key, e.g. `/pets/{id}`) is meant to be interpreted relative
to the path component of a `servers[].url` entry (or, converted from Swagger 2.0, `basePath`) -
but no built-in generator reads `servers`/`basePath` at all, even though the field reaches every
generator's spec JSON (it's part of the engine's own `Document`/`PathItem` model). This is a
deliberate convention, not an oversight: a spec's `servers` entry is typically a dev/staging
placeholder, and the real base URL/mount point is an environment-specific deploy-time decision the
integrator makes, not something baked into generated code. Concretely:

- **Client generators** always emit each operation's path as-is (leading `/` included) and leave
  the base URL entirely to the caller's own HTTP client setup (a `Faraday::Connection`'s `url:`, a
  Go client's `baseURL` constructor argument, a Kotlin client's `baseUrl`, ...). Combining a
  caller-supplied base URL that itself has a non-root path (e.g. `.../v1`) with an operation's own
  leading-`/` path is the generator's job to get right without silently truncating the base -
  see `ruby_faraday_client_generator`'s README for a worked example of a bug class this caused
  (RFC 3986 URL-merge semantics silently discarding a base path) and how it's now handled.
- **Server generators** always register each operation's path as-is too; mounting a server under a
  prefix (e.g. to match a spec's `servers`/`basePath`, or a reverse proxy's own path) is always an
  explicit, deterministic step the deployer performs using that target framework's own mechanism
  (Rails `scope`/`namespace`, Go `http.StripPrefix`/a wrapping mux, Ktor a nested `Route`, Tornado
  prefixing its own `URLSpec` patterns) - see each server generator's own README for specifics.

## Loading a generator

`-g` accepts:
1. **`builtin:<name>`** - one of the generators embedded directly into the `openapi-yagen` binary
   at compile time (currently `kotlin_ktor_client`, `kotlin_ktor_server`, `typescript_fetch_client`,
   `ruby_faraday_client`, `ruby_rails_server`, `python_tornado_server`, `go_net_http_client`, and
   `go_net_http_server` - run `openapi-yagen list-generators` for the
   current list with descriptions). Works with no local checkout, network access, or filesystem at
   all. Use
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
