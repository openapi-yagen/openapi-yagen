# JavaScript API reference

The generator core supports all modern JavaScript features from ES2023 (string interpolation,
classes, `let`/`const`, modules...) thanks to [QuickJS](https://bellard.org/quickjs/).

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

### OpenAPI-specific functions (JS only)

#### `kindOf`, `constraintsOf`, `nameOf`, `collectOperations`

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

`kindOf`/`constraintsOf`/`nameOf` only work while a schema still has its original JS object
identity - that is, before it's passed into `renderTemplate`/`renderTemplateToString` (which
converts `data` via an internal value tree with no object identity) or into a function called from
inside a template. Call them in `main.js` first, build a plain object with the results, and pass
*that* into the template - not the raw schema object.

### File output (JS only)

#### `copyFile`

Copies a file from the generator folder straight into the output directory, unmodified - for
static runtime files that need no substitution (previously the only way to emit one was
`renderTemplate` against a template with no `{{ }}` in it at all).

```typescript
copyFile(srcFileName: string, outFileName: string): void
```
```js
copyFile("Validation.kt", `${pkgPath}/Validation.kt`); // no templating needed for this file
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
