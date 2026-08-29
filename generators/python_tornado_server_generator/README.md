---
title: Python Tornado server generator
sidebar_label: Python Tornado server
slug: /generators/python-tornado-server
description: Generate validated Tornado server routes and handler interfaces from OpenAPI.
---

# python_tornado_server_generator

Generates [Tornado](https://www.tornadoweb.org/) server routing for an OpenAPI spec: one dataclass
per object schema (`from_wire`/`to_wire`/`validate` included - Python has no compiler to reject a
wrong-shaped value the way a statically-typed target does), and per OpenAPI tag a handler interface
you implement plus one `tornado.web.RequestHandler` subclass per path.

Incoming requests are parsed and validated - path/query/header/cookie parameters and, for bodies whose
schema has constraints, the deserialized body - **before** the handler is called, so handler
implementations only ever see clean, typed, already-valid Python values. All constraint-checking
logic lives once in the generated `runtime.py` and is called from every operation/model instead of
being duplicated per handler.

Tornado brings its own `Application`/`HTTPServer`/`IOLoop`, so unlike a WSGI-toolkit target
(Werkzeug, and by extension Flask) the generated code needs no separate WSGI server - it's a
complete, self-sufficient server stack on its own.

## Usage

```bash
openapi-yagen g -o out -g python_tornado_server_generator openapi.yaml -v packageName=petstore_api
```

| Variable      | Required | Description                                            |
|---------------|----------|------------------------------------------------------------|
| `packageName` | yes      | Python package name for the generated code (e.g. `petstore_api`) |
| `strict`      | no (default `true`) | `true`: an unsupported schema/operation aborts generation with an error. `false`: skip it with a printed warning and generate everything else - useful for large real-world specs (see "Known limitations" below). |
| `generate`    | no (default `all`) | `all`: models.py plus the apis/ routes/handlers. `models`: only `models.py`. `api`: everything except `models.py` (`apis/`, `runtime.py`). |

## Output layout

```
<packageName>/
  __init__.py
  models.py               every schema's dataclass/type alias, in one module
  apis/
    __init__.py
    <tag>.py               handler interface + RequestHandler subclasses + build_<tag>_routes()
  runtime.py               shared parameter-extraction/constraint-checking helpers
```

Written under a real `<packageName>`-named directory - Python requires a file's location to match
its import path, so `-o` should point at the parent directory the package gets created inside.

Every schema lives in a single `models.py`, not one file per schema. This is a deliberate choice:
splitting models across files would mean either hand-tracking which model needs which sibling
import (real circular-import risk for models that reference each other) or a blanket wildcard
re-export - `models.py` sidesteps that complexity entirely while staying just as easy to read for a
spec of this size.

## Integrating the generated code

Implement the generated handler interface with your business logic, then build a `tornado.web.
Application` from `build_<tag>_routes()`:

```python
from petstore_api.apis.pets import PetsHandler, build_pets_routes
from petstore_api.models import NewPet, Pet
from tornado.ioloop import IOLoop
from tornado.web import Application

class PetsService(PetsHandler):
    def list_pets(self, *, limit: Optional[int]) -> List[Pet]:
        ...
    def create_pet(self, *, body: NewPet) -> Pet:
        ...
    def show_pet_by_id(self, *, pet_id: str) -> Pet:
        ...

application = Application(build_pets_routes(PetsService()))
application.listen(8080)
IOLoop.current().start()
```

A validation failure (a missing required parameter, a constraint violation, a malformed body) is
raised as the generator's own `runtime.ValidationError`, immediately caught by the generated
`RequestHandler` method and re-raised as `tornado.web.HTTPError(422, reason=str(exc))` - Tornado's
own idiomatic way to signal an HTTP error. `HTTPError`'s default `write_error` sends a small HTML
error page; pass `-v handlerBaseClass=your_app.support.BaseHandler` (a dotted
`module.path.ClassName`) to have every generated `RequestHandler` subclass your own base instead of
`tornado.web.RequestHandler` directly, and override `write_error(status_code, **kwargs)` there to
control the actual JSON error body your application wants to send (and/or `prepare()`/`on_finish()`
for request-ID correlation, logging, auth, ...) - the generator itself doesn't hardcode any of this:

```python
# your_app/support.py
import json
from tornado.web import HTTPError, RequestHandler

class BaseHandler(RequestHandler):
    def write_error(self, status_code: int, **kwargs: object) -> None:
        exc_info = kwargs.get("exc_info")
        reason = exc_info[1].reason if exc_info and isinstance(exc_info[1], HTTPError) else self._reason
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"error": reason, "uid": "..."}))
```

```bash
openapi-yagen g -o out -g python_tornado_server_generator openapi.yaml \
    -v packageName=petstore_api -v handlerBaseClass=your_app.support.BaseHandler
```

### Model types

An `enum` schema generates a plain `class Name(str, Enum)` (or `(int, Enum)`) with `from_wire`/
`to_wire` staticmethods and a no-op `validate()` - `from_wire` wraps the constructor (`Name(value)`
already raises `ValueError` on an unrecognized value, re-raised as `ValidationError`).

A discriminated `oneOf`/`anyOf` (`discriminator.propertyName` set, every variant a `$ref`) and an
undiscriminated one both generate a plain class acting as a `from_wire`/`to_wire` dispatch
namespace - no instance of that class is ever constructed; `from_wire` returns an instance of
whichever variant class matched (by discriminator value, or by the JSON value's shape for an
undiscriminated union), and `to_wire` dispatches back out the same way:

```python
shape = Shape.from_wire(payload)  # returns a Circle or Square instance directly
if isinstance(shape, Circle):
    ...
Shape.to_wire(shape)
```

Generation fails if an undiscriminated union's variants can't be unambiguously told apart from the
raw JSON alone (e.g. two object variants with no property that distinguishes them).

A `type: string` property/parameter with `format: date`/`date-time` gets a real `datetime.date`/
`datetime.datetime` type instead of a plain `str` - `from_wire`/query-and-path-parameter parsing
routes through `datetime.date.fromisoformat`/`datetime.datetime.fromisoformat` (normalizing a
trailing `Z` UTC designator first, for correctness on any supported Python version, not just
3.11+, which is the first to accept `Z` natively), and `to_wire` calls `.isoformat()` back - the
parse doubles as the validation, so a malformed date/date-time value is rejected at the point it's
first read, not deferred to a separate check. `format: uuid` stays a plain `str` (no
dependency-free stdlib UUID type this generator reaches for) - a struct property or parameter with
it is shape-checked by `validate()`/parameter parsing: the canonical 8-4-4-4-12 hyphenated hex
form.

An optional property's `default` schema keyword becomes the real literal default for both entry
points into a model: the dataclass field's own default (`NewWidget(name="Gizmo", owner="carol")`
gets `priority=1` without you passing it) and `from_wire`'s absent-key handling
(`NewWidget.from_wire({"name": "Gizmo", "owner": "carol"})` too). An **explicit** JSON `null` still
wins over the default - `NewWidget.from_wire({..., "priority": None}).priority` is `None`, not `1`
- Python's `key in d` is what makes this "absent vs. explicit null" distinction cheap to generate
directly, unlike a language needing a custom (de)serializer for it. A `default` on a required
property, or one whose value doesn't map to a recognized literal shape (an object/array default, or
a `format: date`/`date-time` default), is ignored - the property keeps its ordinary
required/`None`-default handling.

### Authentication

`http`/`bearer`, `apiKey`, `oauth2`, and `openIdConnect` security schemes are supported - the
latter two treated identically to `http`/`bearer` (RFC 6750: an OAuth2/OIDC access token travels as
`Authorization: Bearer <token>` regardless of how it was obtained), with no scope/claim validation
of the token itself (just presence, same as every other scheme).

A `security` requirement naming a single scheme, or several required together (AND -
`security: [{a: [], b: []}]`), gives the handler method one extra keyword-only, required `str`
parameter per scheme, already extracted and validated before the handler runs:

```python
def delete_pet(self, *, pet_id: str, bearer_auth_token: str) -> None: ...
```

A `security` with two or more OR-alternatives (`security: [{a: []}, {b: []}]`, optionally with an
AND-combination inside one or more alternatives) instead gives the handler one `Optional[str]`
parameter per *unique* scheme name across every alternative, all extracted the same way but never
individually required - the generated method body tries each alternative in the spec's own
declared order, first one whose every scheme is non-`None` wins:

```python
def favorite_widget(self, *, widget_id: int, oauth_2_auth_token: Optional[str], api_key_auth_key: Optional[str]) -> None: ...
```

Either way, a missing credential (no scheme populated for a single-scheme/AND operation, or no
alternative fully satisfied for an OR one) raises the generator's own
`runtime.MissingAuthenticationError` - deliberately not a `ValidationError` (or a subclass of it) -
immediately caught by the generated `RequestHandler` method and re-raised as
`tornado.web.HTTPError(401, reason=str(exc))`, alongside the existing `ValidationError` -> 422
mapping.

### Request/response body content types

Request/response body content types are picked from whichever the spec declares in priority order
`application/json` > `multipart/form-data`/`application/x-www-form-urlencoded` > (a single
remaining media type, received/sent as `str` for any `text/*` media type, or raw `bytes`
otherwise):

- **`application/json`** (default): the body is `json.loads`-parsed, converted via the schema's own
  generated `from_wire`, and validated (`.validate()` for an object schema, or the same recursive
  constraint walk for a Map/array/primitive schema) before the handler is called - the handler
  method's `body:` parameter is the generated type.
- **`multipart/form-data`/`application/x-www-form-urlencoded`**: Tornado parses either into the
  same `self.get_body_argument()`/`self.get_body_arguments()` API, so one generated code path
  covers both. The schema must be `type: object` with only primitive/enum-typed properties, or
  arrays of either (`self.get_body_arguments`, the plural sibling of `self.get_body_argument` -
  one repeated key per element, OpenAPI's default `style: form, explode: true`); a nested object
  property, or an array of non-scalar items, is a generator error - each field is extracted
  individually, then the constructed object's own `validate()` is called once for required-ness and
  every declared constraint, same as the JSON encoding's whole-body validation. A `type: string,
  format: binary` property (a file field) maps to a real `bytes`, and - **multipart only** - is read
  from Tornado's own `self.request.files` (a real uploaded file part, not a plain form field) rather
  than `self.get_body_argument`; the same property in a urlencoded body is a generator error (a
  urlencoded body has no file-part concept to read one from).
- **a single `text/*` media type** (`text/plain`, `text/csv`, `text/html`, ...): the handler
  method's `body:`/return type is a plain `str` - `self.request.body.decode("utf-8")` /
  `self.write(result)`, no JSON involved.
- **a single other media type** (`application/octet-stream`, `application/zip`, `image/png`, ...):
  the handler method's `body:`/return type is raw `bytes` - `self.request.body` /
  `self.write(result)` directly, no encoding/decoding.

  A request/response body declaring two or more media types outside the ones above is ambiguous
  (which one would the generated handler actually expect?) and is a generator error, same as any
  other unsupported content-type - see "Known limitations".

### Path/query/header/cookie parameters

Must resolve to a primitive scalar type (string/integer/number/boolean), an enum, or (query
parameters only) an array of one of those, serialized as repeated `?name=a&name=b` keys (OpenAPI's
default `style: form, explode: true`) - path/header/cookie parameters stay scalar-only. An object,
nested array, or `oneOf`/`anyOf` in one of these positions is a generator error. A cookie parameter
is read via `self.get_cookie(name)` - not to be confused with a cookie-*located* `apiKey` security
scheme (`in: cookie` on the scheme itself, see "Authentication" below), which is a separate,
already-correct code path.

## Known limitations (v1)

- Request and response bodies support `application/json`, `multipart/form-data`, `application/
  x-www-form-urlencoded`, a single `text/*` media type (as `str`), and a single other media type
  (as raw `bytes`) - see "Request/response body content types" above. A requestBody/response
  declaring two or more media types outside those fixed ones is a generator error (aborts
  generation under default `strict=true`; skips just that operation with a printed warning under
  `-v strict=false`).
- `security` schemes are limited to `http`/`bearer`, `apiKey`, `oauth2`, and `openIdConnect` -
  `mutualTLS`/HTTP Basic is a generator error - see "Authentication" above.
- Body/model validation covers `minLength`/`maxLength`/`pattern`/`minimum`/`maximum`/
  `exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`/`minItems`/`maxItems`/`uniqueItems`/
  `minProperties`/`maxProperties`/`const`/`format: uuid` (a shape check) and `format: date`/
  `date-time` (typed as real `datetime.date`/`datetime.datetime`, parse-as-validation - see "Model
  types" above), and recurses into nested object properties (via their own
  generated `validate()`), array elements, and Map (`additionalProperties`) values - but only for a
  property/parameter whose own declared type is directly one of those shapes, not through a `$ref`
  to a Map/array/primitive-kind schema (a `$ref` to an **object**, **enum**, or **union** schema is
  always deep-validated, since that's the common case a generated `validate()` method exists for in
  the first place).
- Generated files are not run through a formatter.

## Try it

From the `generators/` directory, with `openapi-yagen` on `PATH`:

```bash
cd generators && openapi-yagen g -o out/python-tornado-server -g python_tornado_server_generator/src \
    -c python_tornado_server_generator/test/resources/kitchensink.yaml -v packageName=petstore_api
```

For a real generate-then-run check exercising every operation, positive and negative, see
[`test/`](https://github.com/openapi-yagen/openapi-yagen/tree/master/generators/python_tornado_server_generator/test) -
this generator's own self-contained test suite (see also
[`../README.md`](../README.md) for the collection-wide convention): `pip install -r
test/requirements.txt && OPENAPI_YAGEN=/path/to/openapi-yagen pytest test/`, which regenerates from
`test/resources/kitchensink.yaml`, boots the result behind `tornado.testing.AsyncHTTPTestCase`
against fake handler implementations, and asserts on every generated operation's positive and
negative (validation, wrong-type parameter, ...) behavior - no real network or socket beyond
Tornado's own in-process test client.
