---
title: Sample C++ models generator
sidebar_label: Sample C++ models
slug: /generators/sample-cpp-models
description: A minimal example that generates C++ model structs from OpenAPI schemas.
---

# sample_cpp_models_generator

Minimal example generator: turns OpenAPI schemas into plain C++ structs (and array schemas into
`std::vector<...>` aliases). Mainly useful as a small, readable reference when writing or
debugging a generator (see [`docs/javascript-api.md`](../../docs/javascript-api.md) for the
engine's built-in functions/globals this generator uses: `kindOf`, `nameOf`, `renderTemplate`).

## Usage

```bash
openapi-yagen g -o out -g sample_cpp_models_generator/src \
    -c openapi.yaml -v "namespace=MyModels"
```

| Variable    | Required | Description                          |
|-------------|----------|---------------------------------------|
| `namespace` | no       | C++ namespace to wrap the generated structs in |

## Output layout

```
model.h   one header with one struct per object schema, one `using` alias per array schema
```

## Known limitations

- Only `object` (→ `struct`) and `array` (→ `using X = std::vector<...>`) top-level schemas are
  handled; other schema shapes (enum, oneOf/anyOf, allOf, plain scalars) are silently skipped.
- Only primitive scalar property types are mapped (see `lib.js`'s `mapType`); no nested
  object/array properties, no `$ref` resolution beyond what the engine already resolves.
- No validation/constraints are emitted.
- Generated files are not run through a formatter by default - see `run.sh` for an example
  wiring `clang-format` via `-p`.

## Try it

From the `generators/` directory, with `openapi-yagen` on `PATH`:

```bash
cd generators && ./run.sh
```
generates into `generators/out` from `test/resources/petstore.yaml`.

There is no `test/` subdirectory for this generator yet - see
[`generators/README.md`](../README.md) for the `README.md`/`src/`/`test/` convention this
generator should eventually adopt too.
