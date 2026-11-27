# Generator conventions

Rules for every generator under `generators/` (and any new one). Verify them whenever you add a
generator or rework an existing one's templates - not just that the output compiles/runs.

- **Every generator must thread OpenAPI `description` into generated doc comments** (KDoc/TSDoc/
  Doxygen `///`, whatever the target language uses) - not just capture it into the JS-side model
  and drop it before rendering. This covers: the model/class itself (schema `description`), each
  field/property, each generated operation/method (`operation.summary` **and** `operation.description`
  - both, not just `summary`; a longer `description` is common and gets silently dropped if only
  `summary` is wired up), each parameter (as `@param`-style lines where the target language's doc
  convention supports it), and - easy to miss entirely, since nothing else in the engine reads it -
  the API class/interface itself, sourced from the document's top-level `tags: [{name, description}]`
  array (`schema.tags` in JS - distinct from `op.tags`, which only lists tag *names* on an
  operation). If the generator also emits a single bundle/facade class that aggregates one
  instance of every tag's class (e.g. a client generator's top-level `ApiClient`, constructed once
  from shared config), that bundle class gets its own doc comment too, sourced from the document's
  top-level `info.description` (`schema.info.description` in JS) - distinct again from any one
  tag's description, since the bundle represents the whole API. Each *property* on that bundle
  class (one per tag) also needs its own doc comment - the same tag description already shown on
  the class it points to, not left bare just because the class itself is already documented. See
  `kotlin_ktor_client_generator`/`kotlin_ktor_server_generator`/
  `typescript_fetch_client_generator`'s `lib/operations.js` (`buildDocComment` calls/`tagDescription`) and
  their model templates for the reference implementation - when adding a new generator or
  reworking an existing one's templates, verify all of the above still holds, not just that the
  code compiles/runs.
- **Take a property's description from `propertyDescription(schema, propName)`**, not from
  `propSchema.description`: for a `$ref` property the latter is the target schema's, losing what the
  property says next to the `$ref`.
- **A generator for a dynamically-typed target language must generate its own runtime checks** -
  don't rely on "it'll fail somewhere eventually." TypeScript/Kotlin generators get a wrong-shaped
  value (wrong class, wrong property type) rejected for free by the target's own compiler; a
  dynamically-typed target (Ruby today; Python/PHP/untyped JS if this repo ever grows one of those)
  has no such backstop - a caller can hand a generated method literally anything, and without the
  generator's own checks it goes straight to the wire unvalidated. The reference implementation is
  `ruby_faraday_client_generator`: a type/shape check at the point a caller-constructed value
  crosses into "about to be serialized" (`to_wire`: `is_a?` for a model class, `ALL_VALUES.include?`
  for an enum, an explicit raise on an unmatched union variant instead of a silent passthrough),
  plus generated constraint validation (`minLength`/`pattern`/`minimum`/`maximum`/enum membership/
  ... via the engine's `constraintsOf()`) through a generated `validate!` method per model - see
  `src/lib/serialization.js`'s `buildValidateStatements` and `src/templates/model_class.rb.j2`.
  Make this an **opt-out** generator variable (on by default), not unconditional, so a well-tested
  integration can skip the overhead in production once it's earned that - see that generator's
  `validate` variable. When adding a new generator for another dynamically-typed language, apply
  the same pattern; a statically-typed target's compiler already covers the "wrong shape" half of
  this, but still gets nothing for free on OpenAPI-level constraints like `minLength`/`pattern` -
  worth the same consideration there too.
- **Comments in GENERATED code must not reference the generator's own internals** - no `.j2`
  template filenames, `AGENTS.md`, `main.js`, internal JS function names (`buildValidateStatements`
  and the like), or other generators in this project by name. The reader of a generated file only
  has that file - not this repo's source. A comment explaining something about *that file itself*
  (a method's behavior, a data format, OpenAPI semantics) is fine, even at length - a comment
  explaining why the generator's authors chose one implementation over another is not.
- **A generator's README documents USE, not DESIGN** - a clear description of what the generator
  produces, step-by-step integration with working examples, and practically relevant behavior
  (formats, errors, limitations). The reader has only that one README, not the whole repo - don't
  send them to `AGENTS.md` or to another generator's README ("same restriction X applies" / "see
  that generator's README for..."); inline the fact itself instead. Don't explain why one
  implementation choice was made over another unless it changes how the reader uses the generator.
