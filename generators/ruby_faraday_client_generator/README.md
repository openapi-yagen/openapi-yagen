---
title: Ruby Faraday client generator
sidebar_label: Ruby Faraday client
slug: /generators/ruby-faraday-client
description: Generate a Ruby API client that takes a caller-supplied Faraday::Connection.
---

# ruby_faraday_client_generator

Generates a Ruby API client: one plain Ruby class per OpenAPI object schema (hand-written
`to_h`/`from_h` JSON (de)serialization - no runtime-reflection gem needed), one module per enum,
one dispatching module per `oneOf`/`anyOf`, plus one client class per tag with a method per
operation.

The generated code never picks (or creates) an HTTP adapter - each client class takes an
already-configured [`Faraday::Connection`](https://lostisland.github.io/faraday/) in its
constructor. That's what makes it work with whichever Faraday adapter (the default `net_http`,
`Typhoeus`, `httpx`, ...) your own `Gemfile` already uses, and lets you configure retries, default
headers, logging, or anything else via ordinary Faraday middleware on the connection you pass in -
none of that is the generated code's concern.

## Usage

```bash
openapi-yagen g -o out -g ruby_faraday_client_generator openapi.yaml -v moduleName=PetStore
```

| Variable     | Required | Description                                                          |
|--------------|----------|------------------------------------------------------------------------|
| `moduleName` | yes      | Ruby module namespace for the generated client and model classes (e.g. `PetStore`). Also determines the file layout below (`lib/<snake_case moduleName>/...`), following ordinary Ruby gem conventions. |
| `strict`     | no (default `true`) | `true`: an unsupported schema/operation aborts generation with an error. `false`: skip it with a printed warning and generate everything else - useful for large real-world specs (see "Known limitations" below). |
| `validate`   | no (default `true`) | `true`: every model gets a `validate!` method enforcing the schema's constraints, called automatically before a request body is sent (see "Validation" below). `false`: zero validation overhead - reverts to a bare `to_h`/`to_wire` with no type or constraint checking at all. |

## Output layout

```
lib/<module>/models/<name>.rb   one file per schema (class / enum module / union dispatch module)
lib/<module>/apis/<tag>_client.rb   one client class per OpenAPI tag
lib/<module>/api_client.rb      ApiClient - bundles one instance of every tag's client class
lib/<module>/runtime.rb         OpenapiYagenRuntime - the shared request()/query/auth/error helper
lib/<module>.rb                 aggregator - requires every file above, in a safe order
```

(`<module>` is `moduleName` converted to `snake_case`, e.g. `PetStore` -> `pet_store`.)

## Integrating the generated code

You own the `Faraday::Connection` - build one however you like, and inject it into `ApiClient` (or
directly into one tag's own client class, if you only need one):

```ruby
require_relative "out/pet_store"

connection = Faraday.new(url: "https://api.example.com/v1") do |f|
  f.adapter Faraday.default_adapter # net_http by default - swap for Typhoeus/httpx/... freely
end

api = PetStore::ApiClient.new(connection: connection)
pet = api.pets.get_pet_by_id(pet_id: "123")
```

```ruby
pets_api = PetStore::PetsClient.new(connection: connection) # only need one tag? skip ApiClient
```

Do **not** install a JSON-parsing response middleware (e.g. `faraday-json`'s
`Faraday::Response::Json`) on the connection you inject - `OpenapiYagenRuntime.request` parses the
raw response body itself, and a response body that's already been parsed into a Hash by your own
middleware would make it try to `JSON.parse` a Hash and fail.

### Request body content types

Request-body content types are picked from whichever the spec declares in priority order
`application/json` > `multipart/form-data` > `application/x-www-form-urlencoded` > (a single
remaining media type, sent as a plain `String`). The first three build the **same typed `body:`
argument** (an instance of the schema's generated model class) - only the wire encoding differs:

- **`application/json`** (default): `body.to_h` is `JSON.generate`'d.
- **`application/x-www-form-urlencoded`**: `body.to_h`'s flat wire Hash is encoded with Ruby's
  stdlib `URI.encode_www_form` - no extra gem needed. The schema must be `type: object` with only
  scalar/enum properties, or arrays of either (`URI.encode_www_form` already serializes an
  Array-valued Hash entry as one repeated key per element, e.g. `channels=sms&channels=email`, with
  no extra code needed for it); a nested object property, or an array of non-scalar items, is a
  generator error - see "Known limitations".
- **`multipart/form-data`**: same schema restriction, plus a `type: string, format: binary`
  property is allowed (a file field) - its value passes straight through untouched. `body.to_h`'s
  Hash is passed as the Faraday request body **unmodified**, with **no** `Content-Type` set - your
  own connection needs [`faraday-multipart`](https://github.com/lostisland/faraday-multipart)
  installed to actually encode it:
  ```ruby
  # Gemfile: gem "faraday-multipart"
  connection = Faraday.new(url: "https://api.example.com/v1") do |f|
    f.request :multipart
    f.adapter Faraday.default_adapter
  end

  api.pets.upload_pet_photo(
    pet_id: "123",
    body: PetStore::PetPhotoUpload.new(
      caption: "Rex at the park",
      photo: Faraday::Multipart::FilePart.new("rex.jpg", "image/jpeg"), # or a File/IO
    ),
  )
  ```
  `faraday-multipart` is **not** a dependency of the generated code itself (this generator never
  adds a gem dependency beyond `faraday` - see "Integrating the generated code" above) - only
  callers who actually invoke a multipart operation need it.
- **any single `text/*` media type** (`text/plain`, `text/csv`, `text/html`, ...) or **any single
  other remaining media type** (`application/octet-stream`, `application/zip`, `application/pdf`,
  `image/png`, ...): `body:` is a plain `String` (Ruby has no separate byte-array type for an HTTP
  body - pass a binary-encoded String, e.g. via `File.binread`, for a non-text media type), sent
  as-is with `Content-Type` set to the exact declared media type (e.g. `text/csv`, not a generic
  `text/plain`). A response declaring the same kind of media type comes back as a plain `String`
  too, not JSON-parsed. The declared schema (`type: string, format: binary` or otherwise) has no
  bearing here - the wire content-type alone decides this, same as it does at runtime for a real
  client/server.

  A requestBody/response declaring two or more media types outside the fixed ones above is
  ambiguous (which one would the generated method actually send/expect?) and is a generator error,
  same as any other unsupported content-type - see "Known limitations".

### Validation

Ruby has no compiler to reject a wrong-shaped or out-of-spec `body:` before it reaches the wire -
passing a plain `Hash`, or a correctly-typed instance with a value that violates the schema
(`minLength`, `pattern`, `minimum`/`maximum`, an
enum value that isn't one of the declared ones, ...), would otherwise be serialized and sent
without anyone noticing. With the default `-v validate=true`, every generated model class gets a
`validate!` method (and every enum/union module's own `to_wire` gets the equivalent check), called
automatically the moment a body is about to be sent. `validate!` checks every property's own basic
type (`String`/`Integer`/`Numeric`/`true`-or-`false` - generated even when the schema declares no
`minLength`/`minimum`/... keywords at all, so a property with no constraints still gets *something*
checked instead of an empty, look-broken `validate!`) and, for a required property that isn't also
`nullable: true`, that it isn't `nil` (Ruby's own mandatory-keyword-argument mechanism only
enforces that `new(...)` was *passed* a value, not that the value itself isn't `nil`) - on top of
the OpenAPI constraint keywords themselves:

```ruby
api.pets.create_pet(body: { name: "Rex" })
# TypeError: expected PetStore::NewPet, got Hash

api.pets.rate_pet(pet_id: "1", x_request_id: "req-1", body: PetStore::Rating.new(score: "not-an-integer", label: "ok"))
# TypeError: "score" has the wrong type: expected Integer, got String

api.pets.create_pet(body: PetStore::NewPet.new(name: ""))
# ArgumentError: "name" must have length >= 1
```

`validate!` is also callable directly, any time before you'd otherwise send it:

```ruby
pet = PetStore::NewPet.new(name: "Rex", tag: "dog")
pet.validate! # raises ArgumentError if anything's wrong; returns self otherwise
```

A `type: string, format: binary` property (a multipart file field - see "Request body content
types" above) is the one exception to the basic-type check above: it accepts a plain `String`, but
also a `File`/`IO`/`StringIO`, or a `Faraday::Multipart::FilePart`/other `UploadIO`-shaped object
(anything responding to `:read` or `:content_type`) - none of which are a Ruby `String`, but all of
which are legitimate ways to supply file content.

This costs something on every request (a type check plus a walk over each constrained property,
recursing into nested models/enums/arrays) - set `-v validate=false` once you trust the values your
own code constructs (e.g. for a production build of an already-tested integration) to fall back to
the bare `to_h`/`to_wire` this generator used before this feature existed, with zero validation
overhead. See also AGENTS.md's "a generator for a dynamically-typed target language must generate
its own runtime checks" convention, which this feature is the reference implementation of.

### Default values

An optional property's `default` schema keyword becomes the real literal default for both entry
points into a model: `initialize`'s own keyword-argument default (`NewPet.new(name: "Rex")` gets
`priority: 1` without you passing it) and `from_h`'s absent-key handling (`NewPet.from_h({"name" =>
"Rex"})` too). An **explicit** JSON `null` still wins over the default - `NewPet.from_h({"name" =>
"Rex", "priority" => nil}).priority` is `nil`, not `1` - Ruby's `Hash#key?` is what makes this
"absent vs. explicit null" distinction cheap to generate directly, unlike a language needing a
custom (de)serializer for it. A `default` on a required property, or one whose value doesn't map to
a recognized literal shape (an object/array default), is ignored - the property keeps its ordinary
required/`nil`-default handling.

### Authentication (`components.securitySchemes`)

An operation with a non-empty `security` in the spec pulls its credential(s) from the client's own
`auth:` constructor argument, not a request-level header - the generated method already knows which
scheme(s) it needs (and, for `apiKey`, which header/query/cookie to put each in), so `auth` only
needs to supply the raw value(s):

```ruby
api = PetStore::ApiClient.new(
  connection: connection,
  auth: {
    bearer: -> { fetch_fresh_access_token },  # http/bearer, oauth2, or openIdConnect - re-invoked every request
    api_key: "sk_live_...",                   # apiKey (header, query, or cookie) - a plain value is fine too
  }
)
```

`oauth2`/`openIdConnect` schemes are treated identically to `http`/`scheme: bearer` (RFC 6750: an
OAuth2/OIDC access token travels as `Authorization: Bearer <token>` regardless of how it was
obtained) - both draw from the same `auth[:bearer]`, since a client only ever holds one kind of
bearer token at a time regardless of which flow issued it. A rotating/expiring bearer token needs
the callable form (`-> { ... }`, or any object responding to `#call`) - a plain string captured once
at construction would go stale.

An operation whose `security` lists more than one alternative (OR) or more than one scheme required
together (AND) sends exactly one request, using whichever alternative's every scheme has a
configured provider - tried in the spec's own declared order, first fully-satisfied one wins:

```yaml
security:
  - oauth2Auth: [write:widgets]   # alternative 1: needs a bearer token alone
  - apiKeyAuth: []                # alternative 2: needs an apiKey alone
```

```ruby
# Only api_key provided -> alternative 1 (needs bearer) isn't satisfied, so alternative 2 is used
# instead - no error, no extra request.
api = PetStore::WidgetsClient.new(connection: connection, auth: { api_key: "..." })
api.favorite_widget(widget_id: "1")
```

Calling a method where **no** alternative is fully configured raises `ArgumentError` immediately
(before any request is sent), naming every alternative's required provider(s)
(`auth[:bearer]`/`auth[:api_key]`).

On any non-2xx response, `OpenapiYagenRuntime.request` raises `OpenapiYagenRuntime::ApiError`
(`#status`, `#response_body` - the best-effort-parsed response body):

```ruby
begin
  api.pets.get_pet_by_id(pet_id: "missing")
rescue OpenapiYagenRuntime::ApiError => e
  raise unless e.status == 404
  # handle not-found
end
```

## oneOf/anyOf support

- **Discriminated** (`discriminator.propertyName` + every variant a `$ref` to a named schema): the
  union gets its own module (e.g. `Shape`) whose `from_h` reads the discriminator property and
  delegates to the matching variant class's own `from_h` (e.g. `Circle.from_h`/`Square.from_h`);
  `to_wire` delegates to `value.class.to_wire(value)`, since every variant is itself an ordinary
  registered class.
- **Undiscriminated** (or discriminated but unresolvable): a shape-dispatching module instead -
  checking each object variant's own distinguishing property first, then any
  array/string/number/boolean-shaped variant, then falling back to whatever's left
  (at most one property-less/unconstrained variant is allowed as that trailing fallback). A
  `oneOf`/`anyOf` that can't be dispatched this way (e.g. two variants sharing the same non-object
  shape with nothing else to tell them apart, more than one fallback, or a variant that's itself a
  nested `oneOf`/`anyOf`) is a generator error (see `strict` above).
- A path/header **parameter's** schema is a different position - see "Known limitations" below.

## Known limitations (v1)

- Request and response bodies support `application/json`, a single `text/*` media type, and a
  single other media type (both as a plain `String`); request bodies additionally support
  `application/x-www-form-urlencoded` and `multipart/form-data` (see "Request body content types"
  above). **A requestBody/response declaring two or more media types outside those fixed ones is a
  generator error** (aborts generation under default `strict=true`; skips just that operation with
  a printed warning under `-v strict=false`) - it is never silently dropped.
- Path/header/cookie parameters must resolve to a primitive scalar or enum (string/number/boolean) -
  an object or array in one of those positions is a generator error. Query parameters have no such
  restriction: any shape (scalar, enum, array, or a plain object for the `deepObject`-style filter
  idiom) is passed straight through - `runtime.rb`'s `build_query` walks it generically at request
  time, since Ruby has no static type to get right ahead of time.
- Query array parameters serialize as a repeated key (`?tag=a&tag=b`, OpenAPI 3's default `style:
  form, explode: true`) - other serialization styles (`explode: false`,
  `spaceDelimited`/`pipeDelimited`) aren't supported.
- `to_h` omits a `nil`-valued property entirely rather than sending an explicit JSON `null` - an
  optional field explicitly set to `null` and one simply left unset are indistinguishable on the
  wire.
- `string` schemas with format `date`/`date-time`/`byte`/`binary` all map to a plain `String` - no
  `Time`/`Date` object, no base64/binary decoding. `validate!` (see "Validation" above) never checks
  `format` itself (`uuid`, `date`, `email`, ...) either - this is a client, constructing a request
  from values your own code already produced, not a server rejecting untrusted wire input, so
  format-level validation is deliberately out of scope here (the same position the Go and Kotlin
  *client* generators take - only the *server* generators in this project validate `format: uuid`).
- `security` schemes are limited to `http`/`scheme: bearer`, `apiKey` (`in: header`, `in: query`, or
  `in: cookie`), `oauth2`, and `openIdConnect` (the latter two treated as a bearer token, RFC 6750;
  no scope/claim validation) - `mutualTLS`/HTTP Basic is a generator error. Multiple simultaneous
  (AND) and alternative (OR) requirements are supported by picking whichever alternative is fully
  configured at request time, not by a single `auth:` shape per scheme kind - a spec needing two
  DIFFERENT bearer-kind credentials in the same AND-group (e.g. two distinct oauth2 schemes
  together) can't be expressed, since `auth:` has only one `:bearer` slot.
- `moduleName` is a single flat Ruby module name (e.g. `PetStore`) - a nested namespace (`Foo::Bar`)
  isn't supported.
- `validate!` (see "Validation" above) doesn't deep-validate a `oneOf`/`anyOf`-typed property - an
  unmatched/wrong value there still surfaces, just one step later, from that union module's own
  strengthened `to_wire` when the body is actually serialized, not from `validate!` itself.
- Validation only runs on the path a value takes to become a request body (`to_wire`, or
  `validate!` called directly) - nothing calls it automatically just because you set a property via
  `attr_accessor` (e.g. `pet.name = ""` doesn't raise until you `validate!`/send it).
- Generated files are not run through a formatter - pipe the output through
  [rubocop](https://rubocop.org)'s `--autocorrect` or [rufo](https://github.com/ruby-formatter/rufo)
  yourself via `-p`/`--post-process` if you want one:
  ```bash
  openapi-yagen g -o out -g ruby_faraday_client_generator openapi.yaml -v moduleName=PetStore \
      -p "rb:rufo %file%"
  ```

## Try it

From the `generators/` directory, with `openapi-yagen` on `PATH` (see `run_ruby_client.sh`,
sibling to `run.sh`):

```bash
cd generators && ./run_ruby_client.sh
```

generates into `generators/out/ruby-client` from `test/resources/petstore.yaml`.

For a real generate-then-run check exercising every operation, positive and negative, see
[`test/`](https://github.com/openapi-yagen/openapi-yagen/tree/master/generators/ruby_faraday_client_generator/test) -
this generator's own self-contained test suite (see also
[`../README.md`](../README.md) for the collection-wide convention):

```bash
cd generators/ruby_faraday_client_generator/test
OPENAPI_YAGEN=/path/to/openapi-yagen bundle install && bundle exec rake test
```
