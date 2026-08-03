# Writing a generator

This is the documentation for writing an `openapi-yagen` generator - a plugin (JS + Inja
templates) that turns a resolved OpenAPI document into source code. For building/testing the
`openapi-yagen` CLI itself, see the root [README.md](../README.md) and [AGENTS.md](../AGENTS.md)
instead.

New to this? Start with the **[tutorial](tutorial.md)** - it builds a small real generator from
scratch, step by step, with every command and its actual output.

Reference material, once you know the shape of things:

- **[Generator format](generator-format.md)** - the folder layout, `generator.yml`, how `-g`
  loads a directory/zip/URL, `--override-dir`, and post-processing generated files.
- **[JavaScript API](javascript-api.md)** - the globals (`schema`, `vars`) and built-in functions
  (`kindOf`, `nameOf`, `constraintsOf`, `collectOperations`, `renderTemplate`, `copyFile`, ...)
  available to `main.js`.
- **[Templating](templating.md)** - the Inja template syntax, calling built-in/custom functions
  from a template, and whitespace control.

Real, complete generators to read alongside this documentation live in
[`../generators/`](../generators/README.md).
