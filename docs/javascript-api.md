---
title: JavaScript API reference
sidebar_label: JavaScript API
slug: /docs/javascript-api
description: Globals and built-in functions available to openapi-yagen JavaScript generators.
---

# JavaScript API reference

The generator core supports all modern JavaScript features from ES2023 (string interpolation,
classes, `let`/`const`, modules...) thanks to [QuickJS](https://bellard.org/quickjs/) - including
its standard library: `JSON`, `Map`, `Set`, `RegExp`, `Array`/`Object` methods, and everything else
ES2023 itself defines are all available with no setup, on top of the custom globals/built-ins
documented below. `JSON.stringify`, in particular, doubles as a correct escaped-and-quoted string
literal for any JS/TS-family output (see also `toStringLiteral` below for other languages).

`main.js` (and anything it `import`s) runs with the global values and built-in functions described
below already in scope - no `require`/`import` needed for any of them.

## Global values

- **`schema`** - the parsed OpenAPI specification (contents of the `spec-file`), mirroring the
  original document 1:1 (every field, including vendor/`x-*` extensions, unchanged) with exactly
  one difference: every `$ref` is replaced by the actual object it points to. A schema reached
  through two different `$ref`s (or a self-referential one) is the *same* JS object (`===`), not a
  copy - so cyclic types work, but it also means you should never pass a piece of `schema` directly
  as `renderTemplate`'s `data` if it might be cyclic (see `renderTemplate` below); use `schema` for
  navigation and build a fresh plain object per render instead.
- **`vars`** - an object with the resolved generator variables (see `-v`/`--var` and the
  `variables` section of `generator.yml` - [`generator-format.md`](generator-format.md)), keyed by
  variable name.

```js
renderTemplate("model.h.j2", { schemas: schema.components.schemas, namespace: vars.namespace }, "model.h");
```

## Built-in functions

These are split into two groups: a handful of general string/identifier helpers usable from both
JS *and* templates (see [`templating.md`](templating.md) for calling them from Inja), and a set of
OpenAPI-specific + file-output functions usable from JS only.

### Common functions (JS and templates)

#### `dump`

Logs values for debugging - a replacement for `console.log`.

```typescript
dump(...args: any): void
```
```js
dump("found", Object.keys(schema.components.schemas).length, "schemas");
// -> Dump: found 3 schemas
```

#### `toCamelCase`, `toPascalCase`, `toSnakeCase`, `toScreamingSnakeCase`

Converts a string identifier from any case convention to the specified one.

```typescript
toCamelCase(s: string): string // -> camelCase
toPascalCase(s: string): string // -> PascalCase
toSnakeCase(s: string): string // -> snake_case
toScreamingSnakeCase(s: string): string // SCREAMING_SNAKE_CASE
```
```js
toPascalCase("pet-status"); // -> "PetStatus"
toSnakeCase("PetStatus");   // -> "pet_status"
```

#### `isValidIdentifier`, `sanitizeIdentifier`

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
```js
isValidIdentifier("pet_status"); // -> true
isValidIdentifier("pet-status"); // -> false
sanitizeIdentifier("pet-status"); // -> "pet_status"
```

#### `toStringLiteral`

Produces a JSON-style double-quoted, backslash-escaped string literal - also valid syntax for most
C-family languages' double-quoted string literals (C/C++/Java/Kotlin/JS/TS/C#/Go all treat
`\\`/`\"`/`\n`/`\r`/`\t` the same way), so most generators need no hand-rolled escaping at all for
emitting a string constant. Doesn't add a target language's *extra* escaping needs beyond that
(e.g. Kotlin also escapes `$` because of string templates) - wrap the result yourself for that one
additional rule if your target needs it.

```typescript
toStringLiteral(s: string): string
```
```js
toStringLiteral('He said "hi"\n'); // -> "\"He said \\\"hi\\\"\\n\""
```

#### `splitPathTemplate`

Splits an OpenAPI path template into its literal and `{param}` segments, in declaration order -
every generator that builds a path-interpolation expression for path parameters needs exactly this
split; this saves reimplementing the same regex/parsing logic (and risking it drifting slightly)
in every generator.

```typescript
splitPathTemplate(path: string): Array<{ literal: string } | { param: string }>
```
```js
splitPathTemplate("/pets/{petId}/ratings");
// -> [{ literal: "pets" }, { param: "petId" }, { literal: "ratings" }]
```

### OpenAPI-specific functions (JS only)

#### `kindOf`, `constraintsOf`, `nameOf`, `collectOperations`

Since `$ref` is already resolved on `schema`, these save you from re-deriving the bookkeeping every
generator otherwise needs: classifying a schema's shape, extracting its validation keywords,
recovering the name a resolved schema/parameter/requestBody/response was reached through (there's
no `$ref` string to read anymore), merging path-level + operation-level parameters, and resolving
each operation's effective `security` (its own, if declared - even declared empty, meaning "no
auth" - otherwise the document-level default, per the spec's own inheritance rule).

```typescript
kindOf(schema: object): "Object" | "Array" | "Enum" | "AllOf" | "OneOf" | "AnyOf" | "Map" | "Primitive" | "Unknown"
constraintsOf(schema: object): { minimum?, maximum?, exclusiveMinimum?, exclusiveMaximum?, multipleOf?, minLength?, maxLength?, minItems?, maxItems?, minProperties?, maxProperties?, pattern?, uniqueItems? }
nameOf(x: object): string | null // null if x is an inline/anonymous definition, never reached via $ref
collectOperations(): Operation[] // { method, path, operationId, summary, description, tags, parameters, requestBody, responses, security }
```

`security` is `Array<{ [schemeName: string]: string[] }>` - each entry names a security scheme
(look it up in `schema.components.securitySchemes` for its `type`/`scheme`/`name`/`in`/... to know
how to apply it) plus the scopes required for that scheme (non-empty only for `oauth2`/
`openIdConnect`). An empty array means the operation needs no authentication; multiple entries in
one array element mean all of those schemes are required together (AND); multiple array elements
are alternatives (OR) - satisfying any one of them is enough.

```js
for (const [name, s] of Object.entries(schema.components.schemas)) {
  if (kindOf(s) === "Object") { /* ... */ }
}
for (const op of collectOperations()) {
  const responseSchema = op.responses["200"]?.content?.["application/json"]?.schema;
  const typeName = responseSchema && nameOf(responseSchema); // null -> anonymous/inline type
}
```

`kindOf` reads `schema.type` however your generator's declared `openApiVersion` shapes it (see
[`generator-format.md`](generator-format.md#spec-versions-and-conversion)): a plain string for a
generator on OAS 3.0 (`"string"`), or - for a generator that declared `openApiVersion: "3.1"`/
`"3.2"` - either a string or a JSON Schema type array (`["string", "null"]`); either way `kindOf`
classifies correctly. Nullability follows the same split: OAS 3.0-targeting generators see a
`schema.nullable` boolean, OAS 3.1/3.2-targeting ones see `"null"` inside the `type` array instead
- there's no `nullable` key on that dialect.

#### `firstSuccessResponse`

Picks the response every generator otherwise re-derives by hand: the first declared `2xx` status
code (sorted), falling back to `"default"`, or `null` if `responses` has neither.

```typescript
firstSuccessResponse(responses: object): { statusCode: string, response: object } | null
```
```js
for (const op of collectOperations()) {
  const picked = firstSuccessResponse(op.responses);
  const schema = picked?.response.content?.["application/json"]?.schema;
}
```

#### `flattenAllOf`

Recursively merges a schema's own `properties`/`required` with every (possibly itself `allOf`-
bearing) branch of its `allOf`, into a single flat `{ properties, required }` - every generator
handling `allOf` otherwise hand-rolls a one-level-only version of this same merge.

```typescript
flattenAllOf(schema: object): { properties: { [name: string]: object }, required: string[] }
```
```js
const merged = flattenAllOf(schema.components.schemas.Cat);
for (const [name, propSchema] of Object.entries(merged.properties)) {
  const required = merged.required.includes(name);
}
```

#### `resolveDiscriminator`

Detects a discriminated `oneOf`/`anyOf` (`discriminator.propertyName` set, every variant a `$ref`
to a named schema - the one shape a target language with algebraic/discriminated-union support can
dispatch on a single literal property) and resolves each variant's component name plus its
discriminator literal value (from `discriminator.mapping`, falling back to the component name
itself when a variant has no explicit mapping entry, per the OpenAPI spec's own default). Returns
`null` for anything else (no discriminator, or a variant that isn't a named `$ref`) - treat that as
an ordinary, non-dispatchable union instead.

```typescript
resolveDiscriminator(schema: object): { property: string, variants: Array<{ name: string, literal: string }> } | null
```
```js
const disc = resolveDiscriminator(schema.components.schemas.Shape);
// -> { property: "shapeType", variants: [{ name: "Circle", literal: "circle" }, { name: "Square", literal: "Square" }] }
```

`kindOf`/`constraintsOf`/`nameOf`/`firstSuccessResponse`/`flattenAllOf`/`resolveDiscriminator` only
work while a schema still has its original JS object identity - that is, before it's passed into
`renderTemplate`/`renderTemplateToString` (which converts `data` via an internal value tree with no
object identity) or into a function called from inside a template. Call them in `main.js` first,
build a plain object with the results, and pass *that* into the template - not the raw schema
object. `firstSuccessResponse`/`flattenAllOf`/`resolveDiscriminator` each build a fresh plain
result object per call, but everything nested inside that result (a response's schema, a merged-in
property that's a `$ref`, ...) keeps its original identity - so `nameOf`/`kindOf` still work on
those nested values afterwards.

### File output (JS only)

#### `copyFile`

Copies a file from the generator folder straight into the output directory, unmodified - for
static runtime files that need no substitution (previously the only way to emit one was
`renderTemplate` against a template with no `{{ }}` in it at all).

```typescript
copyFile(srcFileName: string, outFileName: string): void
```
```js
copyFile("Validation.kt", "Validation.kt"); // no templating needed for this file
```

#### `renderTemplate`

Renders the template at `templateFilePath` (in the generator folder) into `outFilePath` with the
given `data` object. Additionally, you can pass a set of JS-defined `functions` that will be
available for use in that template.

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
```js
renderTemplate("model.h.j2", { schemas: schemasForTemplate, namespace: vars.namespace }, "model.h");
```

#### `renderTemplateToString`

The same as `renderTemplate`, but returns the rendered result as a string instead of writing a
file - useful for building up a larger output (e.g. rendering a fragment per schema, then
assembling and writing them yourself), or post-processing the text before writing it.

```typescript
renderTemplateToString(
    templateFilePath: string,
    data: { [key: string]: any },
    functions?: { [name: string]: Function }
): string
```
```js
const fragment = renderTemplateToString("field.j2", { name: "id", type: "string" });
```
