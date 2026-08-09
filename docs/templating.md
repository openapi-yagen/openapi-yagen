---
title: Templating reference
sidebar_label: Templating
slug: /docs/templating
description: Inja syntax, functions, inheritance, includes, and whitespace control.
---

# Templating reference

[Inja](https://pantor.github.io/inja/) (version 3.5.0 - see `inja/` in `conanfile.txt`) is the
template rendering engine (Jinja-like syntax). This page covers the syntax itself, plus how this
project's built-in functions and generator-supplied data connect to it. Everything below was
verified against this project's actual pinned Inja version - if in doubt, [Inja's own
docs](https://pantor.github.io/inja/) and [source](https://github.com/pantor/inja) are the
tie-breaker, but note that Inja's feature set has changed across versions (e.g. no ternary
operator, `range()` only takes one argument), so don't assume something from a different version
of the Jinja/Inja family works here without checking.

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

## Expressions

`{{ ... }}` prints an expression. Access object properties and array elements both with `.` -
there's no separate `[]` indexing syntax:

```jinja
{{ schema.title }}
{{ items.0 }}
```

Operators, in the usual precedence:

- Arithmetic: `+ - * / %` (`+` also concatenates strings: `{{ "a" + "b" }}` -> `ab`)
- Comparison: `== != < <= > >=`
- Logical: `and or not` (not `&&`/`||`/`!`)
- Membership: `in` (works on arrays; `not (x in y)` for negation - `not in` as one token isn't
  supported)

There is **no ternary operator** (`? :`) and no Python-style `a if cond else b` - use
`{% if %}`/`{% else %}` instead, or a `default()`/`{% set %}` combination for a single value.

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

### Line statements

`##` at the very start of a line is an alternative to wrapping that whole line in `{% ... %}` -
whitespace before `##` disables it (it's then just literal text), but content after it is parsed
exactly like inside `{% %}`. It works for every statement - `if`/`else if`/`else`/`endif`,
`for`/`endfor`, `set`, `include`, `extends`, `block`/`endblock` - just not for printing an
expression, which still needs `{{ }}`. The two control-flow examples above, rewritten:

```jinja
## for schemaKey, schemaValue in schemas
## if schemaValue.kind == "object"
struct {{ schemaKey }} {
## for propKey, propValue in schemaValue.properties
    {{ propValue.type }} {{ propKey }};
## endfor
};
## endif
## endfor
```

```jinja
## if kind == "array"
std::vector<{{ itemType }}>
## else if kind == "map"
std::map<std::string, {{ valueType }}>
## else
{{ type }}
## endif
```

A line statement also consumes its own trailing newline, so unlike `{% %}` it never needs a `-` to
avoid leaving a blank line behind (see [Whitespace control](#whitespace-control)) - which is why
it tends to read better for any control-flow tag that already occupies a whole line by itself. For
a tag that's inline with surrounding text on the same line - like the comma-joining loop below -
`{% %}` is still the right tool, since a line statement always claims the entire line.

### Loop variables

Inside `{% for %}`, `loop` exposes the usual bookkeeping - handy for comma-separated lists or
first/last-specific formatting:

```jinja
{% for p in model.properties %}{{ p.name }}{% if not loop.is_last %}, {% endif %}{% endfor %}
```

- `loop.index` / `loop.index1` - 0-based / 1-based position
- `loop.is_first` / `loop.is_last` - booleans
- `loop.parent` - the enclosing loop's `loop` object, for nested `{% for %}` (`loop.parent.index1`)

`{% for key, value in someObject %}` (used above) iterates an object's entries instead of an
array's elements.

## Variable assignment

`{% set %}` (or `## set`) introduces a template-local variable (or overwrites an existing key,
including a dotted path into an object already in scope) - useful to avoid repeating an
expression, or to build up a value conditionally before using it:

```jinja
## set fullType = type
## if nullable
## set fullType = fullType + "?"
## endif
{{ fullType }} {{ name }};
```

## Comments

`{# ... #}` is stripped entirely from the output - not even whitespace-collapsed like `-`, just
removed:

```jinja
{# TODO: revisit once nested allOf is flattened upstream #}
```

## Inja's own built-in functions

Beyond this project's [common functions](#calling-built-in-functions-from-a-template), Inja ships
a fixed set of its own, callable the same way (`{{ upper(name) }}`) or piped (`{{ name | upper }}`
- the two are equivalent, pipe just reads left-to-right and chains more easily:
`{{ items | sort | join(", ") }}`).

| Function | Signature | Notes |
| --- | --- | --- |
| `upper`, `lower` | `(s)` | Case conversion |
| `capitalize` | `(s)` | Uppercases only the first character |
| `replace` | `(s, search, replacement)` | |
| `length` | `(arrayOrString)` | |
| `first`, `last` | `(array)` | |
| `at` | `(array, index)` | |
| `sort` | `(array)` | No custom comparator |
| `join` | `(array, separator)` | |
| `range` | `(n)` | `0, 1, ..., n-1` - **one argument only**, no `range(start, end)` |
| `round` | `(number, precision)` | |
| `odd`, `even` | `(n)` | |
| `divisibleBy` | `(n, divisor)` | |
| `max`, `min` | `(array)` | |
| `int`, `float` | `(s)` | Parses a string to a number |
| `exists` | `(key)` | Is `key` set in the root data object |
| `existsIn` | `(object, key)` | Is `key` set in `object` |
| `default` | `(value, fallback)` | `fallback` if `value` is undefined |
| `isArray`, `isBoolean`, `isFloat`, `isInteger`, `isNumber`, `isObject`, `isString` | `(value)` | Type checks |

```jinja
{{ model.properties | length }} properties
{{ default(vars.namespace, "app") }}
```

There's no `reverse`, `urlencode`, or `trim` in this version - roll your own with `main.js` and
pass it in as a custom function ([see above](#calling-built-in-functions-from-a-template)) if you
need one.

## Template inheritance

`{% extends "base.j2" %}` plus `{% block name %}...{% endblock %}` works the same way Jinja's
does, resolved through the same file lookup as `{% include %}`. A base template declares
overridable regions:

```jinja
{# base.h.j2 #}
#pragma once
## block includes
#include <string>
## endblock
## block body
## endblock
```

and a child overrides them, optionally calling `{{ super() }}` (still needs `{{ }}` - it's an
expression, not a statement) to still emit the base block's own content:

```jinja
## extends "base.h.j2"
## block includes
{{ super() }}
#include <vector>
## endblock
## block body
struct {{ model.name }} { /* ... */ };
## endblock
```

## Including other templates

`{% include "other.j2" %}` (or `## include "other.j2"`) inlines another template file (resolved
the same way as everything else - relative to the generator's own root, or `--override-dir` if it
provides one). Useful for sharing a license header or a set of `#include`s across multiple output
files:

```jinja
## include "head.h.j2"
## set includes = ["<string>", "<vector>", "<optional>"]
## include "includes.h.j2"
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

The same thing with [line statements](#line-statements) needs no `-` at all, since `##` already
consumes its own line's trailing newline:

```jinja
## for p in model.properties
    val {{ p.name }}: {{ p.type }},
## endfor
```

Inja can also auto-trim the newline after every tag (`env.set_trim_blocks(true)`) and leading
whitespace before one (`env.set_lstrip_blocks(true)`) - **this project doesn't enable either**
(`InjaTemplateRenderer` constructs a plain `inja::Environment` with defaults), so a tag on its own
line still leaves its line break in the output unless you add `-` yourself.

See Inja's own docs for anything not covered here:
https://pantor.github.io/inja/
