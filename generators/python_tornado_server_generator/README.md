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

Incoming requests are parsed and validated - path/query/header parameters and, for bodies whose
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

Written under a real `<packageName>`-named directory, unlike this collection's Kotlin generators -
Python, unlike Kotlin, requires a file's location to match its import path, so `-o` should point at
the parent directory the package gets created inside.

Every schema lives in a single `models.py`, not one file per schema (unlike the Kotlin/Ruby/
TypeScript generators in this collection). This is a deliberate, Python-specific choice: Python has
no lightweight equivalent of Kotlin's package-relative type resolution or Ruby's `require`-anywhere
module system, so splitting models across files would mean either hand-tracking which model needs
which sibling import (real circular-import risk for models that reference each other) or a blanket
wildcard re-export - `models.py` sidesteps that complexity entirely while staying just as easy to
read for a spec of this size.

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
for request-ID correlation, logging, auth, ...) - the generator itself doesn't hardcode any of this,
the same way this collection's Kotlin server generator leaves `BadRequestException` -> 400
body-shaping to the integrator's own `StatusPages` install rather than baking one in:

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

### Request/response body content types

Request/response body content types are picked from whichever the spec declares in priority order
`application/json` > (a single remaining media type, received/sent as `str` for any `text/*` media
type, or raw `bytes` otherwise):

- **`application/json`** (default): the body is `json.loads`-parsed, converted via the schema's own
  generated `from_wire`, and validated (`.validate()` for an object schema, or the same recursive
  constraint walk for a Map/array/primitive schema) before the handler is called - the handler
  method's `body:` parameter is the generated type.
- **a single `text/*` media type** (`text/plain`, `text/csv`, `text/html`, ...): the handler
  method's `body:`/return type is a plain `str` - `self.request.body.decode("utf-8")` /
  `self.write(result)`, no JSON involved.
- **a single other media type** (`application/octet-stream`, `application/zip`, `image/png`, ...):
  the handler method's `body:`/return type is raw `bytes` - `self.request.body` /
  `self.write(result)` directly, no encoding/decoding.

  A request/response body declaring two or more media types outside `application/json` plus one of
  the above is ambiguous (which one would the generated handler actually expect?) and is a generator
  error, same as any other unsupported content-type - see "Known limitations".

## Known limitations (v1)

- **No `oneOf`/`anyOf`/`enum` support yet.** A schema using any of these is a generator error
  (aborts generation under default `strict=true`; skips just that schema/operation with a printed
  warning under `-v strict=false`).
- **No `multipart/form-data` or `application/x-www-form-urlencoded` request bodies.** Request and
  response bodies support `application/json`, a single `text/*` media type (as `str`), and a single
  other media type (as raw `bytes`) - see "Request/response body content types" above.
- **No security scheme / auth codegen.** An operation's `security` requirement is not read at all -
  add your own authentication as a Tornado `prepare()` override (e.g. on the same shared base
  `RequestHandler` used for error-body shaping above) until this generator grows support.
- Path/query/header parameters must resolve to a primitive scalar type (string/integer/number/
  boolean) - an object, array, or `oneOf`/`anyOf` in one of those positions is a generator error.
  There is no array-typed (repeated-key) query parameter support yet.
- Body/model validation covers `minLength`/`maxLength`/`pattern`/`minimum`/`maximum`/
  `exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`/`minItems`/`maxItems`/`uniqueItems`/
  `minProperties`/`maxProperties`/`const`, and recurses into nested object properties (via their own
  generated `validate()`), array elements, and Map (`additionalProperties`) values - but only for a
  property/parameter whose own declared type is directly one of those shapes, not through a `$ref`
  to a Map/array/primitive-kind schema (a `$ref` to an **object** schema is always deep-validated,
  since that's the common case a generated `validate()` method exists for in the first place).
- Generated files are not run through a formatter.

## Try it

From the `generators/` directory, with `openapi-yagen` on `PATH`:

```bash
cd generators && openapi-yagen g -o out/python-tornado-server -g python_tornado_server_generator/src \
    -c ../test/resources/petstore.yaml -v packageName=petstore_api
```

For a real generate-then-run check exercising every operation, positive and negative, see
[`test/`](test/) - this generator's own self-contained test suite (see also
[`../README.md`](../README.md) for the collection-wide convention): `pip install -r
test/requirements.txt && OPENAPI_YAGEN=/path/to/openapi-yagen pytest test/`, which regenerates from
`test/resources/kitchensink.yaml`, boots the result behind `tornado.testing.AsyncHTTPTestCase`
against fake handler implementations, and asserts on every generated operation's positive and
negative (validation, wrong-type parameter, ...) behavior - no real network or socket beyond
Tornado's own in-process test client.
