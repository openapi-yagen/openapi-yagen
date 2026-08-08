# Templating reference

[Inja](https://pantor.github.io/inja/) is the template rendering engine (Jinja-like syntax). Its
own documentation is the primary reference for the templating language itself; this page covers
how this project's built-in functions and generator-supplied data connect to it.

## Calling built-in functions from a template

The [common functions](javascript-api.md#common-functions-js-and-templates) (`dump`,
`toCamelCase`/`toPascalCase`/`toSnakeCase`/`toScreamingSnakeCase`, `isValidIdentifier`,
`sanitizeIdentifier`, `toStringLiteral`, `splitPathTemplate`) are available in every template
automatically:

```jinja
{% set value = toSnakeCase("FirstSecondThird") %}
{{ dump(value) }}
```

Any additional `functions` passed as `renderTemplate`'s 4th argument (or
`renderTemplateToString`'s 3rd) are available the same way, by the name you gave them:

```js
renderTemplate("model.h.j2", { schemas }, "model.h", {
  mapType: (t) => ({ string: "std::string", integer: "int" })[t] ?? t,
});
```
```jinja
{{ mapType(propValue.type) }} {{ propKey }};
```

The OpenAPI-specific functions (`kindOf`, `constraintsOf`, `nameOf`, `collectOperations`,
`firstSuccessResponse`, `flattenAllOf`, `resolveDiscriminator`) are **not** usable inside templates
- they rely on JS object identity, which is gone by the time data reaches a template (see
[`javascript-api.md`](javascript-api.md#openapi-specific-functions-js-only)). Resolve everything
you need from them in `main.js` first, and pass the plain result into `data`/`renderTemplate`.

## Basic control flow

```jinja
{% for schemaKey, schemaValue in schemas %}
{% if schemaValue.kind == "object" %}
struct {{ schemaKey }} {
    {% for propKey, propValue in schemaValue.properties %}
    {{ propValue.type }} {{ propKey }};
    {% endfor %}
};
{% endif %}
{% endfor %}
```

`{% if %}` chains with `{% else if %}` / `{% else %}` (not Jinja's `{% elif %}`):

```jinja
{% if kind == "array" %}
std::vector<{{ itemType }}>
{% else if kind == "map" %}
std::map<std::string, {{ valueType }}>
{% else %}
{{ type }}
{% endif %}
```

## Including other templates

`{% include "other.j2" %}` inlines another template file (resolved the same way as everything
else - relative to the generator's own root, or `--override-dir` if it provides one). Useful for
sharing a license header or a set of `#include`s across multiple output files:

```jinja
{% include "head.h.j2" %}
{% set includes = ["<string>", "<vector>", "<optional>"] %}
{% include "includes.h.j2" %}
```

## Whitespace control

A `-` next to a tag delimiter (`{%- ... -%}`, `{{- ... -}}`) trims adjacent whitespace/newlines -
useful for keeping generated output free of the blank lines a `{% for %}`/`{% if %}` would
otherwise leave behind:

```jinja
{% for p in model.properties -%}
    val {{ p.name }}: {{ p.type }},
{% endfor -%}
```

See Inja's own docs for the full expression/control-flow/whitespace-control syntax:
https://pantor.github.io/inja/
