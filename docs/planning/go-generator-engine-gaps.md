# Engine gaps found while extending the Go generators

**Internal planning document, not part of the published docs site** - see
[`generator-simplification.md`](generator-simplification.md)'s header for why `docs/planning/` is
the right place for this (outside the non-recursive `docs/*.md` glob the website build globs).

Running log kept alongside the Go generator feature work requested in-session (closing the
`go_net_http_{client,server}_generator` vs. [ogen](https://github.com/ogen-go/ogen) feature gaps -
see the session's own comparison write-up). Each entry: what generator-side code had to work around
a missing engine capability, and what an engine fix could look like. Not all of these are worth
building - this is a discovery log, not a committed backlog; triage happens once the underlying
feature work (oauth2/OR-security, format validation, recursive `Validate()`, multipart nesting,
oneOf-discrimination flexibility, cookie params, `default` support) is done.

## 1. No template-level recursion/macro-with-arbitrary-nesting forces raw-Go-string building in JS

**Where**: `go_net_http_server_generator/src/lib/operations.js`, `buildAuthBlock`/
`renderAuthChain`/`renderAuthAlternative` (added for OR-alternative `security` requirement
support).

Resolving which of 2+ alternative security requirements a request satisfies needs an
arbitrarily-deep nested-if chain (one level per scheme in an AND-combination *within* one
alternative, one attempt per alternative). Since Inja's `{% macro %}` (per
`generator-simplification.md`'s already-implemented recommendations) doesn't support a macro
calling itself, this couldn't be expressed as a template macro recursing over "the rest of the
schemes in this alternative" - it had to be hand-built as a fully-formed multi-line Go source
string in JS (manual `"\t".repeat`-style indent bookkeeping via a `indent` string parameter threaded
through the recursion), then interpolated into the template with a single `{{ op.authBlock }}` and
relying on the template's own surrounding `{% filter indent(...) %}` to place it correctly.

This works, but it's exactly the kind of thing the templating layer's `indent` filter already
solves for pure-template content - a generator author has to re-solve indent bookkeeping by hand
the moment the logic needs recursion. If Inja macros supported self-recursion (or the engine
exposed a small JS-side "code writer" helper - push/pop indent level, append line - so at least the
indent bookkeeping isn't hand-rolled per call site), this class of "arbitrarily-nested generated
control flow" would be cheaper to write correctly across any generator that needs it (not just
Go's security-alternative resolution - anywhere a spec construct's cardinality varies).

## 2. `toCamelCase`/`toPascalCase` mishandle a digit-to-letter transition as a word-internal position

**Where**: `lib/common/string_tools.cpp`'s `splitToWords` (`islower(prevCh) && !islower(ch)` is the
only split rule), consumed via `paramName()`/`typeName()` in every generator.

A digit is neither `islower` nor `isupper`, so the split rule (word boundary = "previous char was
lowercase, this one isn't") fires going *into* a digit (`...h` -> `2` splits) but not coming *out of*
one (`2` -> `A` does not split, since `islower('2')` is false, so the "previous was lowercase"
half of the condition never holds). A name like the security scheme `oauth2Auth` + suffix `Token`
therefore splits to words `["oauth", "2auth", "token"]` instead of `["oauth", "2", "auth",
"token"]`/`["oauth2", "auth", "token"]`, and `toCamelCase` (which re-capitalizes every word after
the first) produces `oauth2authToken` instead of the expected `oauth2AuthToken` - the letter
immediately after an embedded digit loses its capitalization signal. Confirmed via the server
generator's `kitchensink.yaml` fixture (`oauth2Auth` security scheme -> generated handler param
`oauth2authToken`).

Not a correctness bug (the identifier is still valid, unique, and compiles) - just less idiomatic
casing than a human would write, for any OpenAPI name containing a digit adjacent to an intentional
capital (scheme names like `oauth2Auth`/`http2Something`, or a spec author's own
`ipv4Address`-style names that happen to end up split oddly elsewhere too). Worth a `splitToWords`
fix (treat a digit as neither forcing nor blocking a split on its *own*, but still allow the
following letter to start a new word if it's uppercase) if another instance of this turns up during
the rest of this work - logging now rather than fixing, since it's shared code affecting every
generator and deserves its own dedicated test pass, not a fix bundled into a Go-generator commit.

## 3. `resolveUnionDispatch` only supports shape + property-*presence* dispatch, not property-*value*/-*type* dispatch

**Where**: `lib/generator/openapi_generator.cpp:517-731` (`classifyVariantDispatch`,
`declaredFieldsOf`/`findUniqueDistinguishingField`, `resolveUnionDispatchBuiltin` - the C++ behind
the `resolveUnionDispatch` JS builtin every non-TS generator's `registerUnion`/undiscriminated-union
handling calls). Discovered while scoping "more flexible oneOf discrimination" (ogen supports
type-based, explicit-discriminator, field-*name*, field-*type*, and field-*value* strategies; this
engine function only ever supported the first and third).

For an undiscriminated `oneOf`/`anyOf` with 2+ object-shaped variants, the engine's own dispatch
resolver only ever asks "does exactly one variant declare a property named X" - it never looks at
that property's *value* (e.g. two variants sharing a `type` field, disambiguated only by
`type: circle` vs `type: square` as a JSON Schema `enum`/`const`, without a formal
`discriminator: {propertyName: ...}` keyword - ogen's "field-value discrimination") or its *type*
across variants (`status: string` in one variant vs `status: integer` in another - ogen's
"field-type discrimination"). A spec shaped either way is currently a hard `resolveUnionDispatch`
error ("no distinguishing field") in every one of the **six** generators that call it
(`kotlin_ktor_{client,server}`, `go_net_http_{client,server}`, `python_tornado_server`,
`ruby_faraday_client`) - this is genuinely shared, actively-used engine surface, not
Go-generator-specific.

This is squarely an *engine* gap, not something to work around inside just the Go generator: adding
a second, Go-only dispatch algorithm alongside the shared one would exactly reproduce the
duplication `generator-simplification.md`'s `resolveUnionDispatch` recommendation was written to
eliminate in the first place (own history: previously ~150 duplicated lines per Kotlin generator).
The function is well-isolated (three focused functions, no state leakage elsewhere) and already has
direct unit coverage (`test/generator_test.cpp:473-620`, both success and every rejection path) -
extending it would mean teaching `declaredFieldsOf` to also capture each property's
`enum`/`const` value(s), adding a value-uniqueness pass alongside the existing name-uniqueness one,
and returning a `dispatchValue` (or similar) field on the affected variants for every calling
generator's template to consume. Moderate, contained effort - the main risk is scope creep in the
ambiguity-detection edge cases (partial enum overlap, mixed value/type dispatch on the same
property), not architectural risk.
