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

## 1. ~~Auth-alternative resolution was hand-built as a raw Go string in JS, not an Inja macro~~ (fixed)

**Where**: `go_net_http_server_generator/src/lib/operations.js`'s `buildAuthParams`,
`go_net_http_server_generator/src/templates/server_routes.go.j2`'s `authTry`/`authAlternative`
macros (OR-alternative `security` requirement support).

Resolving which of 2+ alternative security requirements a request satisfies needs an
arbitrarily-deep nested-if chain (one level per scheme in an AND-combination *within* one
alternative, one attempt per alternative). At the time this was first written it wasn't known
whether Inja's `{% macro %}` (per `generator-simplification.md`'s already-implemented
recommendations) supported a macro calling itself, so instead of risking it, this was hand-built as
a fully-formed multi-line Go source string in JS (`buildAuthBlock`/`renderAuthChain`/
`renderAuthAlternative`, manual `"\t".repeat`-style indent bookkeeping via an `indent` string
parameter threaded through the recursion), then interpolated into the template with a single
`{{ op.authBlock }}`.

**Update**: macro self-recursion does in fact work end to end (`{% macro down(n) %}{% if n > 0
%}{{ n }},{{ down(n - 1) }}{% endif %}{% endmacro %}{{ down(3) }}` renders `"3,2,1,"` - see
`docs/templating.md`'s "Macros" section) and always has, since the renderer re-walks a macro's body
on every call rather than inlining it at parse time. What was actually missing was a recursion
depth guard: a macro without a base case didn't throw `inja::RenderError`, it crashed the whole
process (SIGSEGV from exhausting the C++ call stack) with no diagnosable error. That's now fixed in
the vendored fork (`RenderConfig::max_macro_recursion_depth`, default 200, throws
`inja::RenderError` naming the offending macro).

**Follow-up done**: `buildAuthBlock`/`renderAuthChain`/`renderAuthAlternative` are gone - JS now
only builds the plain data (`authAlternatives`, an array of arrays of scheme objects) and
`server_routes.go.j2` recurses over it directly via two macros (`authTry(schemes, i)` for the
AND-chain within one alternative, `authAlternative(schemes)` for one OR-alternative), relying on
the template's own `indent` filter (piped over each recursive call's own output) instead of a
hand-threaded indent parameter - exactly the "engine already solves this" simplification this entry
originally called for. Verified byte-identical generated output against the old JS-built version
for a single-scheme-per-alternative case, plus new coverage
(`TestArchiveWidgetANDWithinORSecurityAlternatives` in `go_net_http_server_generator/test/
server_test.go`) for a multi-scheme AND-within-OR alternative, which the existing kitchensink
fixture didn't previously exercise at all.

## 2. ~~`toCamelCase`/`toPascalCase` mishandle a digit-to-letter transition as a word-internal position~~ (fixed)

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
`ipv4Address`-style names that happen to end up split oddly elsewhere too).

**Fixed**: `splitToWords` now also splits on a digit immediately followed by an uppercase letter
(`isdigit(prevCh) && isupper(ch)`), on top of (not replacing) the existing lowercase-to-non-lowercase
rule - `oauth2Auth` + `Token` now produces `oauth2AuthToken`, and `ipv4Address`/`http2Something`
split the same way a human would expect. New coverage in `test/common_test.cpp` ("Split words" and
"To camelCase across a digit-to-letter boundary" sections). Checked the other four generators'
kitchensink fixtures for any digit-adjacent-letter identifier that might shift naming under this
fix - none found, so no other generator's expected test output needed updating.

## 3. `resolveUnionDispatch` only supports shape + property-*presence* dispatch, not property-*value*/-*type* dispatch (field-value fixed; field-type still open)

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

**Field-value dispatch fixed**: `resolveUnionDispatch` now runs a second pass
(`findFieldValueDispatch`, alongside the existing `findUniqueDistinguishingField`) among whichever
object variants presence-based dispatch couldn't resolve - a property every one of them declares,
each pinning it to a distinct `const`/single-entry-`enum` literal (`singleLiteralValueOf`), returned
as a new `dispatchValue` field per variant (`null` for field-name dispatch or the shape-only
fallback). Purely additive (existing consumers ignore the new field, still get identical results for
specs that already resolved via presence) - new coverage in `test/generator_test.cpp` ("resolveUnionDispatch
falls back to field-value dispatch..."), `docs/javascript-api.md` updated. AllOf-shaped variants are
deliberately out of scope for this pass (documented in `findFieldValueDispatch`'s own comment) - they
just don't match any candidate property and fall through to the pre-existing error, same as before
this fix, not a new incorrect result. **Field-type dispatch** (`status: string` in one variant vs.
`status: integer` in another, with no shared literal) is still unimplemented - nobody's hit a real
spec needing it yet, so it stays logged here rather than spec-built.
