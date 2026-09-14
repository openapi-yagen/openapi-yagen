---
title: Ruby on Rails server generator
sidebar_label: Ruby on Rails server
slug: /generators/ruby-rails-server
description: Generate Rails routing, controllers, and models from an OpenAPI spec.
---

# ruby_rails_server_generator

Generates a Ruby on Rails server: one plain Ruby class per OpenAPI object schema (hand-written
`to_h`/`from_h` JSON (de)serialization, no runtime-reflection gem needed), a controller per tag
that extracts/validates path/query/header/cookie parameters and the request body against the
spec before your code ever sees them, and a `Routes` module you call from your own
`config/routes.rb`.

Two integration styles, chosen via the `controllerMode` variable:

- **`generated`** (default) - the controller is fully generated, never edited by hand. You
  implement a plain Ruby class (no `ActionController` superclass, no `include`) per tag, matching
  the generated interface module, and register one instance of it per tag when you draw your
  routes.
- **`concern`** - only an `ActiveSupport::Concern` is generated per tag. You create your own
  controller under `app/controllers/` (an ordinarily autoloaded, hand-written file), `include`
  the concern, and implement its `on_*` methods directly in that controller.

Both produce identical request handling (the same parameter/body validation, the same auth
extraction, the same error mapping) - only the integration surface differs. See "Integrating the
generated code" below for both.

## Usage

```bash
openapi-yagen g -o .generated -g ruby_rails_server_generator openapi.yaml -v moduleName=PetStore
```

| Variable | Required | Description |
|---|---|---|
| `moduleName` | yes | Ruby module namespace for the generated code (e.g. `PetStore`). Also determines the file layout below (`<snake_case moduleName>/...`). |
| `strict` | no (default `true`) | `true`: an unsupported schema/operation aborts generation with an error. `false`: skip it with a printed warning and generate everything else. |
| `validate` | no (default `true`) | `true`: every model gets a `validate!` method, and every generated controller validates path/query/header/cookie parameters and the request body before calling your code. `false`: zero validation overhead - only turn this off once an integration is well-tested, since on a server this is the only defense against malformed input from an untrusted client. |
| `controllerMode` | no (default `generated`) | `generated`: the controller is fully generated - you register a handler object instead (see below). `concern`: only an `ActiveSupport::Concern` is generated - you write your own controller and `include` it. |
| `baseController` | no (default `ActionController::API`) | Only used when `controllerMode` is `generated`: the class the generated controller inherits from - point this at your own base class to share `before_action` hooks, JSON error shaping, auth, or logging across every generated controller. |

## Output layout

`controllerMode=generated` (default):

```
<module>/models/<name>.rb                          one file per schema (class / enum module / union dispatch module)
<module>/controllers/<tag>_handler_interface.rb     the interface you implement, one module per tag
<module>/controllers/<tag>_controller.rb            fully generated ActionController subclass, one per tag
<module>/routes.rb                                  Routes.draw(mapper, handlers:) - call from config/routes.rb
<module>/runtime.rb                                 OpenapiYagenRuntime - shared validation/parsing/auth helpers
<module>.rb                                         aggregator - requires every file above, in a safe order
```

`controllerMode=concern`:

```
<module>/models/<name>.rb                          same as above
<module>/controllers/<tag>_controller_concern.rb    the ActiveSupport::Concern you `include`, one per tag
<module>/routes.rb                                  Routes.draw(mapper) - call from config/routes.rb
<module>/runtime.rb                                 same as above
<module>.rb                                         same as above
```

(`<module>` is `moduleName` converted to `snake_case`, e.g. `PetStore` -> `pet_store`.)

Point `-o` at a directory outside version control (e.g. `.generated/`, added to `.gitignore`) -
nothing under it is meant to be hand-edited, and regenerating it is meant to be a routine step
(run it before `rails server`/tests/deploy, the same way you'd run a database migration), not a
one-time scaffold.

## Integrating the generated code

Require the aggregator once, then call `Routes.draw` from inside your own
`config/routes.rb`'s `Rails.application.routes.draw do ... end` block, passing `self` and one
handler instance per tag:

```ruby
# config/routes.rb
require Rails.root.join(".generated/pet_store/pet_store")

Rails.application.routes.draw do
  # ... your other routes ...

  PetStore::Routes.draw(self, handlers: {
    pets: PetsHandler.new,
  })
end
```

Your handler is a plain Ruby object - no `ActionController` superclass, no `include`d module
beyond the generated interface itself, which exists purely so a missing/misspelled method fails
loudly (`NotImplementedError`) instead of silently:

```ruby
# app/api_handlers/pets_handler.rb
class PetsHandler
  include PetStore::PetsHandlerInterface

  def get_pet_by_id(pet_id:)
    PetStore::Pet.from_object(Pet.find(pet_id))
  end

  def create_pet(body:)
    PetStore::Pet.from_object(Pet.create!(body.to_attributes))
  end
end
```

`Model.from_object(source)`/`instance.to_attributes` (see "Mapping to your own application
models" below) read/write by Ruby attribute name, not wire name - useful when your ActiveRecord
(or any other) model's column names already match the schema's property names, letting you skip
hand-writing the field-by-field mapping in the common case.

Routes are drawn via `to: Controller.action(:name)` (Rails' routing-directly-to-a-class API),
not a `"controller#action"` string - this is why requiring the aggregator is enough; the
generated controllers never need to be on Zeitwerk's autoload/eager-load paths.

### `controllerMode=concern`

Here there's no separate handler object/registry - your own controller (an ordinarily
autoloaded file under `app/controllers/`) `include`s the generated concern directly and
implements its `on_*` methods:

```ruby
# config/routes.rb
require Rails.root.join(".generated/pet_store/pet_store")

Rails.application.routes.draw do
  PetStore::Routes.draw(self)
end
```

```ruby
# app/controllers/pets_controller.rb
class PetsController < ApplicationController
  include PetStore::PetsController

  def on_get_pet_by_id(pet_id:)
    PetStore::Pet.from_object(Pet.find(pet_id))
  end

  def on_create_pet(body:)
    PetStore::Pet.from_object(Pet.create!(body.to_attributes))
  end
end
```

Since your controller is autoloaded normally, routes here are drawn with an ordinary
`to: "pets#get_pet_by_id"` string - which means the class name matters: Rails resolves it from
the tag's own `snake_case` name (`pets` -> `PetsController`), the same convention any hand-written
Rails route already relies on. You choose your controller's own superclass (`ApplicationController`
and everything it gives you - sessions, CSRF, etc., if you need it) - `baseController` has no
effect in this mode.

### Errors

Both a request-validation failure and a constraint violation map to a single error class -
`OpenapiYagenRuntime::ValidationError` - regardless of whether it surfaced while parsing a
parameter, decoding the request body, or serializing your handler's return value; the generated
controller's `rescue_from` maps it to `422 Unprocessable Content`. A missing/invalid
authentication credential is a distinct class, `OpenapiYagenRuntime::MissingAuthenticationError`,
mapped to `401 Unauthorized`. Both default response bodies are `{"error": "<message>"}` - override
`render_openapi_validation_error`/`render_openapi_missing_authentication_error` in your own
`baseController` to change the shape, or to add logging/request-id correlation.

### Regenerating during development

Because the generated files aren't autoloaded by Zeitwerk (see above), Rails' own code reloading
won't pick up a regeneration on its own - restart the server after re-running `openapi-yagen`
whenever the spec changes.

## Request body content types

Same priority order and the same typed `body:` argument as `ruby_faraday_client_generator`'s own
"Request body content types" section - see that generator's README for the full rationale.
`application/json` > `multipart/form-data` > `application/x-www-form-urlencoded` > a single
remaining media type (as a plain `String`, read via `request.raw_post`). Unlike a JSON body
(where `JSON.parse` already hands back a real `Integer`/`Float`/`true`/`false`), a
multipart/urlencoded form field's `type: integer`/`number`/`boolean`/`format: date`/`date-time`
property is parsed from its raw wire String the same way a query parameter is (see "Parameters"
below) before your model's own `from_h` ever sees it - both content types restrict form fields to
a flat object (scalar/enum properties, or arrays of either), same as the client generator.

## Parameters

- **Path**: always present once the route matched (Rails' own routing guarantee) - no separate
  "required" check.
- **Query/header/cookie**: read from Rails' `params`/`request.headers`/`request.cookies` and
  parsed/validated according to the schema (`Integer`/`Float`/`true`-or-`false`/`Date`/`Time`,
  `format: uuid` shape-checked, an enum's membership checked) before your handler ever sees it -
  raises `OpenapiYagenRuntime::ValidationError` on a malformed value. Restricted to a primitive
  scalar or enum, same restriction `ruby_faraday_client_generator` applies to path/header/cookie
  (query has no such restriction there, since a client only ever *sends* a query value - a server
  has to *parse* one, so this generator can't accept an arbitrary shape it has no generic parsing
  story for).
- **Array-typed query parameters** (OpenAPI 3's default `style: form, explode: true` - a repeated
  key, `?tags=a&tags=b`, the same wire format `ruby_faraday_client_generator`'s own client sends)
  are collected correctly even though Rails' own `params` does NOT do this for a plain
  (non-bracket) repeated key - see `runtime.rb`'s `query_array`.

## Authentication (`components.securitySchemes`)

Same scheme support as `ruby_faraday_client_generator` (`http`/`scheme: bearer`, `apiKey` in
`header`/`query`/`cookie`, `oauth2`, `openIdConnect` - the latter two treated as a bearer token
per RFC 6750; no scope/claim validation) - but a server *verifies presence*, it doesn't inject a
credential. Each security scheme becomes its own keyword argument on your handler method, named
after the scheme (e.g. `bearer_auth:`, `api_key_auth:`), holding the raw extracted value so your
own code can look it up/verify it:

```ruby
# security: [{ bearerAuth: [] }]
def delete_pet(pet_id:, bearer_auth:)
  user = User.from_bearer_token!(bearer_auth) # your own verification
  ...
end
```

A single security requirement makes its scheme(s) required arguments - a missing credential
raises `MissingAuthenticationError` immediately, before your handler is even called. Multiple
alternatives (OR) or multiple schemes together (AND) make every scheme an optional
(possibly-`nil`) argument instead, plus a generated resolution check that raises
`MissingAuthenticationError` unless at least one whole alternative was satisfied:

```yaml
security:
  - oauth2Auth: [write:widgets]   # alternative 1: needs a bearer token alone
  - apiKeyAuth: []                # alternative 2: needs an apiKey alone
```

```ruby
def favorite_widget(widget_id:, oauth_2_auth:, api_key_auth:)
  # exactly one of oauth_2_auth/api_key_auth is guaranteed non-nil here
end
```

## Mapping to your own application models

`Model.from_object(source)` builds a model instance by calling the same-named accessor on
`source` for every property (e.g. `source.id`, `source.name`) - handy when your ActiveRecord (or
any other) model's attribute names already match the schema's. `instance.to_attributes` is the
reverse direction: a `Hash` keyed by Ruby attribute name (unlike `#to_h`, which is wire-shaped),
ready for `Record#update!`/`#assign_attributes`. Neither recurses into a nested
model/array-of-model property - build that yourself first if you need one. A source object
missing a matching accessor raises a plain `NoMethodError` - no attempt is made to guess a
different name.

## YARD documentation

Every generated model property and every handler-interface method parameter/return carries a
`@param`/`@return` YARD tag with its real Ruby type - RubyMine (and any other YARD-aware tool)
uses these to show correct types and flag a mismatched call in your own handler implementation.

## `format: uuid`/`date`/`date-time`

Unlike `ruby_faraday_client_generator` (a client only ever *constructing* an outgoing value, so
format-level validation is out of scope there - see that generator's README), this generator
validates/parses them, since a server receives untrusted wire input:

- `format: uuid` stays a plain `String`, shape-checked (canonical 8-4-4-4-12 hex form) via
  `OpenapiYagenRuntime.require_uuid`.
- `format: date`/`date-time` become a real Ruby `Date`/`Time` - parsing *is* the validation
  (`Date.iso8601`/`Time.iso8601`), raising `ValidationError` on a malformed value.

## oneOf/anyOf support

Same discriminated/undiscriminated dispatch rules as `ruby_faraday_client_generator` - see that
generator's README. One difference: every `from_h`/`to_wire` failure here (an unknown
discriminator value, no variant matching an undiscriminated union's shape, an invalid enum value)
raises `OpenapiYagenRuntime::ValidationError`, not a bare `ArgumentError` - so it's caught by the
same `rescue_from` a constraint violation is, and mapped to the same `422`, no matter which model
file it originated in.

## Known limitations (v1)

- Nothing enforces the `PetsController`-style naming convention `controllerMode=concern` relies
  on at generation time - naming your own controller class anything other than what the tag's
  `snake_case` name implies (e.g. not `PetsController` for tag `pets`) means the route's
  `to: "pets#..."` string simply won't resolve, a plain Rails routing error, not something this
  generator can catch ahead of time.
- Everything `ruby_faraday_client_generator`'s own "Known limitations" already documents about
  content-type support, path/header/cookie parameter shape, query array serialization style
  (`explode: true` only), `moduleName` being a single flat namespace, and `security` scheme
  coverage applies here too, adjusted for the server-side mechanics described above.
- A multipart/urlencoded body's array-typed form field is not currently type-coerced/collected
  reliably the way an array-typed *query* parameter is (see `runtime.rb`'s `query_array`) - stick
  to a single value, or a JSON body, for an array-typed form field.
- Nothing checks, at generation or boot time, that a registered handler actually implements every
  method its tag's interface module declares - a forgotten override only surfaces as a
  `NotImplementedError` the first time that specific operation is actually called.
- Generated files are not run through a formatter - see `ruby_faraday_client_generator`'s README
  for the `-p/--post-process` escape hatch (identical here).

## Try it

This generator's own self-contained test suite (see also [`../README.md`](../README.md) for the
collection-wide convention) regenerates from a kitchen-sink spec exercising every feature above -
**twice**, once per `controllerMode` - and drives the real generated code with
[`Rack::Test`](https://github.com/rack/rack-test) against a bare
`ActionDispatch::Routing::RouteSet` - deliberately just `actionpack`, not the full `rails` gem,
and no `Rails::Application`:

```bash
cd generators/ruby_rails_server_generator/test
OPENAPI_YAGEN=/path/to/openapi-yagen bundle install && bundle exec rake test
```
