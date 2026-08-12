# Generator simplification ideas

**This is an internal planning/analysis document, not part of the published docs site.**
`docs/planning/` holds this kind of write-up - design analyses, backlogs, decision records for
whoever (human or AI agent) picks the work back up - deliberately outside the `docs/*.md` glob
`website/docusaurus.config.ts`'s `include` list uses (non-recursive, so a subdirectory of `docs/`
is invisible to the site build without an explicit opt-in). See also `TODO-improvements.md` at the
repo root for the running gaps/backlog list this kind of document eventually feeds into.

The three built-in generators (`kotlin_ktor_client_generator`, `kotlin_ktor_server_generator`,
`typescript_fetch_client_generator`) have grown organically, each solving the same handful of
"map an OpenAPI schema to a typed model" / "build a callable operation" problems independently in
JS, on top of the engine's existing JS API (`kindOf`, `constraintsOf`, `nameOf`,
`collectOperations`, `firstSuccessResponse`, `flattenAllOf`, `resolveDiscriminator`, plus the
common functions `toCamelCase`/etc., `sanitizeIdentifier`, `toStringLiteral`,
`splitPathTemplate` - see [`javascript-api.md`](javascript-api.md)) and the Inja fork's template
features (`indent`/`center`, `{% filter %}`, macros - see [`templating.md`](templating.md)). This
page catalogs where generator-authored code is solving a problem the *engine* could solve once
instead, so future generators are smaller to write and the existing three stop drifting apart.

**Status**: the "Top recommendations" and "No-engine-change cleanups" sections below are
implemented (engine functions `unwrapSchema`/`resolveUnionDispatch`/`buildDocComment`/
`disambiguateName` added and documented in [`javascript-api.md`](javascript-api.md), all three
generators refactored to use them, `toStringLiteral` now used for wire strings in templates,
`{% macro %}` applied for doc-comment/param-extraction boilerplate) - verified via each
generator's own test suite plus a byte-for-byte diff of regenerated kitchensink output
before/after. The "Also worth doing" section was **not** implemented (see its own note below) and
"Explicitly out of scope" remains just analysis, by design. One recommendation changed on contact
with the codebase: symlinking the byte-identical model templates between the two Kotlin generators
was dropped in favor of leaving them as independent (but still byte-identical) copies - a symlink
across generator directories would break `generators/README.md`'s explicit "each generator is
self-contained, easy to copy out into its own repo" convention, since a plain `cp`/tarball/`git
subtree split` of one generator wouldn't carry its sibling's file the symlink points at.

Findings come from a full read of every JS file (`lib/*.js`, `main.js`) and every `.j2` template
(21 files) across all three generators, cross-checked against an inventory of the engine's actual
current API surface. `sample_cpp_models_generator` was excluded (minimal reference generator, not
comparable in scope).

## Top recommendations (highest value, lowest risk)

### 1. New engine function: schema-shape unwrapping

`unwrapSingleBranch` (peels through a single-branch `oneOf`/`anyOf`/`allOf` wrapper - the common
"attach a sibling `description` next to a `$ref`" idiom - down to the schema that determines the
actual wire shape) is **byte-identical in all three generators**, and each copy's comment
literally cites the others as identical:
- `generators/kotlin_ktor_client_generator/src/lib/operations.js:36-50`
- `generators/kotlin_ktor_server_generator/src/lib/operations.js:36-50`
- `generators/typescript_fetch_client_generator/src/lib/operations.js:33-47`

Add a common function (e.g. `unwrapSchema(schema)`, or `kindOf(schema, {unwrap: true})` as an
**opt-in** variant so `kindOf`'s default behavior doesn't change for existing callers) doing
exactly this. Removes ~15 duplicated lines x3, and simplifies `ktType`/`tsType`'s own inline
single-variant special-casing in each generator's `types.js` (they currently re-derive the same
"is this a trivial 1-variant wrapper" check for the type-name path).

### 2. New engine function: `resolveUnionDispatch(schema)` - sibling to `resolveDiscriminator`

The **largest duplicated block in the codebase**: `registerUnion`'s undiscriminated-`oneOf`/`anyOf`
dispatch-resolution algorithm (classify each variant's wire shape as object/array/string/number/
boolean/any; allow at most one variant per non-object shape; for 2+ object-shaped variants, find
each one a property no sibling object-variant also declares, allowing at most one field-less
"fallback" variant tried last) is ~150 lines, **byte-identical** between the two Kotlin generators:
- `generators/kotlin_ktor_client_generator/src/lib/types.js:135-282`
  (`classifyVariantDispatch`, `declaredFields`, `findUniqueDistinguishingField`, `registerUnion`)
- `generators/kotlin_ktor_server_generator/src/lib/types.js:183-329` (same functions, same bodies)

The engine already ships `resolveDiscriminator()` for the *discriminated* case; add a sibling for
the *undiscriminated* case, e.g. `resolveUnionDispatch(schema) -> { variants: [{ dispatchKind,
dispatchField }] } | null`, doing this classification + fallback-field-finding once in C++.
TypeScript doesn't need this (structural unions, no runtime dispatcher) - only the two Kotlin
generators would consume it, but that's still ~150 duplicated lines gone from each, and any future
JVM/Go/Rust/Python generator gets the same capability for free.

**Bonus, ties into a template finding below**: have the generator (once, in JS) turn each
variant's `{dispatchKind, dispatchField}` into one ready target-language boolean-expression
string (`v.dispatchCondition`) before handing it to the template. This collapses the template-side
10-line nested `{% if dispatchKind == "object" %}...{% else if ... %}` chain (identical in both
Kotlin generators' `model_union.kt.j2:46-55`) down to a single `{% for v in model.variants %}{{
v.dispatchCondition }} -> ...{% endfor %}` - fixing a template readability pain point without
needing any new template syntax.

### 3. New common function: `buildDocComment(summary, description, params)`

Builds a ready `/** ... */`-style KDoc/TSDoc block (or `null` if nothing to document - Inja
treats `""` as truthy, only `null`/`false`/`0`/`[]` are falsy, so this distinction matters and is
already handled correctly in all three copies). **Byte-identical**, including the explanatory
comments, in all three generators:
- `generators/kotlin_ktor_client_generator/src/lib/operations.js:255-266`
- `generators/kotlin_ktor_server_generator/src/lib/operations.js:321-332`
- `generators/typescript_fetch_client_generator/src/lib/operations.js:279-290`

`/** */` block-comment syntax is shared by Kotlin, TS/JS, Java, C#, C/C++ - genuinely
language-agnostic, and the easiest, safest win in this list.

### 4. New common function: `disambiguateName(candidate, reservedNames)`

The "candidate collides with a real schema name -> try `candidateWrapper`, `candidateWrapper2`,
..." collision-avoidance helper for hint-derived synthetic type names (needed because `nameOf()`
returns `null` for anything not reached via `$ref`, so every generator that synthesizes a name
for an inline `oneOf`/`allOf`/object must invent its own collision check against real schema
names). **Byte-identical** in all three:
- `generators/kotlin_ktor_client_generator/src/lib/types.js:68-74`
- `generators/kotlin_ktor_server_generator/src/lib/types.js:110-116`
- `generators/typescript_fetch_client_generator/src/lib/types.js:47-53`

### 5. Bug fix (not an engine gap - existing feature, just unused): use `toStringLiteral` in templates

`toStringLiteral` is an existing, documented, registered common function
(`lib/generator/functions.cpp:31`) - but **grepping all 21 `.j2` templates for it returns zero
matches**. Every wire name/value interpolated into a quoted string literal is instead raw and
**unescaped**: `"{{ p.wireName }}"`, `@SerialName("{{ e.wireValue }}")`,
`@JsonClassDiscriminator("{{ model.discriminatorProperty }}")`, etc. (e.g.
`kotlin_ktor_client_generator/src/templates/api_client.kt.j2:17,21,23,26-27`; both generators'
`model_enum.kt.j2:11`, `model_data_class.kt.j2:10,15`, `model_sealed.kt.j2:11`). A spec with a
`"`, `\`, or newline in a property/parameter name produces broken or unsafe generated code today.
Route these through `toStringLiteral(...)` in the templates (or precompute an already-escaped
field in JS, matching how `validationCalls`' regex patterns already go through
`escapeKotlinString`). Worth fixing as a correctness issue independent of the "reduce size" goal.

## Also worth doing (moderate value)

**Not implemented** (unlike the two sections above): every item here would need `collectOperations()`
itself to change shape (resolved objects instead of raw names in `security`/`tags`, a new
`defaultName` field, ...) - a real API change to a function all three generators already depend on,
for a payoff each item's own writeup already called "moderate" rather than high. Left as analysis
for whoever picks this back up.

- **Tag helpers**: `tagDescription` lookup (`schema.tags.find(t => t.name === tagName)`) and the
  "primary tag = first declared tag, else literal `\"Default\"`" grouping loop are
  byte-identical in all three (`operations.js` - client `:272-275`/`:290`, server
  `:338-341`/`:355`, TS `:296-299`/`:316`). `collectOperations()` could resolve each operation's
  `tags` to `{name, description}` objects (mirroring how it already resolves `security` instead
  of leaving raw scheme names), and/or expose a `groupOperationsByTag()` global.
- **Security-scheme resolution**: `kotlin_ktor_server_generator` and
  `typescript_fetch_client_generator` both re-derive scheme *objects* from
  `schema.components.securitySchemes` by hand after `collectOperations()` only gives scheme
  *names* - identical lookup-or-throw + `type`/`scheme`/`in` branching pattern
  (`kotlin_ktor_server_generator/src/lib/operations.js:215-260`,
  `typescript_fetch_client_generator/src/lib/operations.js:196-235`). `collectOperations()`'s
  `security` field could carry resolved scheme objects, not just names - what to *do* with a
  resolved scheme (bearer vs. apiKey handling) stays generator-specific.
- **Operation default-name derivation**: `operationName`'s "use `operationId` if present, else
  derive from method+path" fallback is identical in all three (`naming.js` - client/server
  `:26-38`, TS `:35-47`). Could become a precomputed `op.defaultName` field on
  `collectOperations()` entries.
- **`application/json` content lookup**: `(x.content || {})["application/json"]` repeated 6x
  across the three generators (`buildRequestBody`/`buildResponse` call sites). A small helper
  (`jsonContentOf(mediaTypeMap)`) or a richer `firstSuccessResponse` return shape would remove it.

## No-engine-change cleanups (pure generator-side, independent of any engine work)

- **~130 lines of dead code in `kotlin_ktor_client_generator`**: `PARAM_CONVERTERS`, `extractFn`,
  and per-param `validationCalls` computation (`operations.js:16-28,123-149,151-194`) exist only
  to parse *untyped incoming HTTP strings server-side* - but the client's own template
  (`api_client.kt.j2`) never references `converter`, `extractFn`, or `validationCalls` at all
  (independently confirmed: zero grep matches). This is dead code copy-pasted from the sibling
  server generator; the TS client generator's own code comments already call this out by name.
  Delete it, following the TS client's already-correct, much thinner pattern.
- **Apply the already-existing macro feature** (from the recent Inja-fork work) to eliminate
  within-generator repetition nobody has factored out yet:
  - The 3-line doc-comment block (`{% if X.description %}/**\n{{ ... | indent(" * ", true)
    }}\n */\n{% endif %}`) repeats 2-4 times *per generator* (e.g.
    `kotlin_ktor_client_generator/src/templates/model_data_class.kt.j2:6-9,12-14`,
    `api_bundle.kt.j2:7-9,11-13`; same shape in every other model/api template across all three
    generators). A `{% macro docComment(text) %}...{% endmacro %}` collapses each occurrence to
    one line.
  - The param-extraction-plus-validation 2-liner (`val {{ p.ktName }} = call.{{ p.extractFn
    }}(...) { {{ p.converter }} }` + validation-calls loop) repeats 3x within
    `kotlin_ktor_server_generator/src/templates/api_routes.kt.j2` alone (pathParams/queryParams/
    headerParams loops) - a clean `{% macro extractAndValidate(p) %}` candidate.
- **Eliminate literal file duplication between the two Kotlin generators**:
  `model_enum.kt.j2`, `model_sealed.kt.j2`, `model_typealias.kt.j2`, and `model_union.kt.j2` are
  **byte-for-byte identical** between `kotlin_ktor_client_generator` and
  `kotlin_ktor_server_generator` (independently re-verified via `diff`; ~107 lines x2). Since
  JS-level sharing across generators is intentionally avoided (each generator is meant to be
  self-contained/independently distributable - see `AGENTS.md`'s "self-containment convention"),
  the lowest-risk fix is a **git symlink** (one generator's copy becomes the source of truth, the
  other a symlink to it) rather than a new cross-generator template-loading mechanism - a symlink
  still resolves to real file content wherever it's read/embedded, so each generator's own
  distributed copy stays intact. `model_data_class.kt.j2` differs only by the server's appended
  `validate()` extension; unifying it too would need a small conditional (e.g. an
  `includeValidate` boolean) - a stretch goal, not required for a first pass.

## Explicitly out of scope / not recommended

- **Kotlin keyword-escaping** (`keywords.js`, identical between the two Kotlin generators),
  **type mapping** (`primitiveKtType`/`primitiveTsType`), **validation-call Kotlin-runtime-name
  mapping**, **signature-string building**, **TS-only import collection/runtime guards**: all
  legitimately per-target-language business logic that belongs in each generator, not the engine
  - even where the *shape* of the code looks similar across generators, the content is
  irreducibly language-specific.
- **A generic "named-model-registry" framework** unifying `registerObject`/`registerEnum`/
  `registerUnion`/`buildModelRegistry`'s two-pass structure across all three generators: the
  per-branch bodies (Kotlin data classes/sealed interfaces vs. TS interfaces/type aliases) are
  irreducibly language-specific. Only the slices already called out above (schema-unwrapping,
  union-dispatch resolution, name disambiguation) are realistically engine-fixable now; treat
  full unification as a longer-term/speculative idea.
- **New Inja syntax** (a `{% switch/case %}` statement; an opt-in per-block whitespace-trim
  mode): both would address template readability pain points, but the `switch/case` motivation
  disappears once recommendation #2's `dispatchCondition` precomputation lands, and the
  whitespace-trim pain is adequately addressed by using macros more (above). Adding new template
  *syntax* is a bigger, riskier engine change for a problem the existing feature set - once
  actually used - already covers.

## If/when implementing any of the above

- Engine additions: add to `lib/generator/functions.cpp`/`.h` following the existing
  common-function pattern (`toStringLiteral`/`splitPathTemplate` as reference), document in
  [`javascript-api.md`](javascript-api.md), add C++ test coverage alongside existing tests in
  `test/`.
- Generator-side changes: regenerate against each generator's own `kitchensink.yaml` fixture and
  run its existing test suite (`gradlew test` / `npm test`) to confirm no behavior change; for the
  symlinked templates, diff regenerated output before/after to confirm it's byte-identical.
- Tackle independently and in the priority order above - this is a list of separable
  improvements, not one patch.
