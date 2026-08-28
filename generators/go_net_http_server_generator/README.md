---
title: Go net/http server generator
sidebar_label: Go net/http server
slug: /generators/go-net-http-server
description: Generate Go HTTP handlers on the standard library's net/http (Go 1.22+ ServeMux) and encoding/json, with no third-party dependencies.
---

# go_net_http_server_generator

Generates a Go HTTP server using only the standard library (`net/http`'s Go 1.22+ method+wildcard
routing, `encoding/json`): one struct per OpenAPI schema in a `models` package, plus per OpenAPI
tag a handler interface and a `RegisterXRoutes` function in a `server` package.

The generated code never creates its own `*http.ServeMux` - `RegisterXRoutes` takes a
caller-supplied `*http.ServeMux` (or anything satisfying its `Handle`/`HandleFunc` method set) and
an implementation of the handler interface. Incoming requests (path/query/header/cookie parameters
and, where constrained, the request body) are parsed and validated before the handler is called,
using shared helper functions in `server/runtime.go` instead of duplicating checks per operation.

## Usage

```bash
openapi-yagen g -o out -g go_net_http_server_generator openapi.yaml \
    -v packageName=github.com/example/petstore
```

`-o` must point at the root of a Go module already initialized with the same import path.

| Variable      | Required | Description |
|---------------|----------|-------------|
| `packageName` | yes      | Go import path for the generated code (e.g. `github.com/example/petstore`). Used to build the import statement `server` code needs to reference `models` - the `package` clause of every generated file is always the literal `models`/`server`, never this value. |
| `strict`      | no (default `true`) | `true`: an unsupported schema/operation aborts generation with an error. `false`: skip it with a printed warning and generate everything else. |
| `generate`    | no (default `all`) | `all`: models plus the server. `models`: only `models/*.go`. `api`: everything except `models/*.go` - see "Sharing models" below. |

## Output layout

```
models/<Name>.go          one file per schema (struct / enum / union / defined type)
server/<Tag>Handler.go    handler interface for one OpenAPI tag, one method per operation
server/RegisterXRoutes.go registers that tag's routes onto a *http.ServeMux
server/runtime.go         parameter parsing/validation helpers, error types, ErrorHandler - rendered once
models/validation.go      ValidationError plus requireMin/requireMax/requireMinLength/requireMaxLength/requirePattern
models/union_helpers.go   internal helpers used by generated oneOf/anyOf wrapper types
```

## Sharing models with the client generator

`models/*.go` is the same output whether it comes from this generator or from
[`go_net_http_client_generator`](../go_net_http_client_generator/README.md) - both generate into a
`models` package with the same template for every model kind, and neither's model files reference
anything client- or server-specific. See that generator's README "Sharing models" section for the
`-v generate=models`/`-v generate=api` workflow.

## Integrating the generated code

Implement the handler interface for each tag, and register it onto a `*http.ServeMux`:

```go
type petsHandler struct{ /* ... */ }

func (h *petsHandler) ListPets(ctx context.Context, limit *int, tag *string, tags []string) (models.Pets, error) {
    // ...
}
// ... every other PetsHandler method

mux := http.NewServeMux()
server.RegisterPetsRoutes(mux, &petsHandler{}, nil)
http.ListenAndServe(":8080", mux)
```

`RegisterXRoutes`'s third argument is an `ErrorHandler` (`func(w http.ResponseWriter, r *http.Request,
err error)`) called whenever parameter parsing, validation, authentication, or the handler method
itself returns an error - `nil` uses `server.DefaultErrorHandler`, which maps a
`*models.ValidationError` to 400, a `*server.MissingAuthenticationError` to 401, and anything else
to 500. Pass a custom `ErrorHandler` for a different error body shape, logging, or request-ID
correlation.

### Authentication

`http`/`bearer`, `apiKey`, `oauth2`, and `openIdConnect` security schemes are supported.
`oauth2`/`openIdConnect` are handled identically to `http`/`bearer`: per RFC 6750, an access token
travels as `Authorization: Bearer <token>` regardless of how it was obtained (authorization-code,
client-credentials, an OIDC provider, ...), and - same as `bearer`/`apiKey` - this generator never
validates a token's signature/scopes/audience itself; that's left entirely to the handler
implementation.

A secured operation's handler method gets one extra parameter per scheme referenced by its
`security`. For a single security requirement (`security: [{a: [], b: []}]`, meaning every scheme
in it is required together), each is a plain `string`, already extracted and validated before the
handler runs:

```go
func (h *petsHandler) DeletePet(ctx context.Context, petId string, bearerAuthToken string) error
```

A security requirement with two or more OR-alternatives (`security: [{a: []}, {b: []}]`, meaning
*either* combination satisfies the request) is also supported: every scheme referenced by any
alternative becomes a `*string` parameter instead (nil unless the alternative it belongs to is the
one that matched), and the generated route wrapper tries each alternative in the spec's declared
order, using the first one whose every scheme is present:

```go
func (h *widgetsHandler) FavoriteWidget(ctx context.Context, widgetId string, oauth2AuthToken *string, apiKeyAuthKey *string) error
```

A missing credential (single requirement) or no satisfied alternative (OR-alternatives) returns a
`*server.MissingAuthenticationError` from `RegisterXRoutes`'s wrapper before the handler is ever
called, mapped to 401 by `DefaultErrorHandler`.

### Model types

See [`go_net_http_client_generator`](../go_net_http_client_generator/README.md)'s README "Model
types" section - struct/enum/union/pointer representation is identical, since both generators
share the same `models` output.

### Request body content types

Same priority order and restrictions as the client generator - see its README "Request body
content types" section. Server-side, a `application/x-www-form-urlencoded` and a
`multipart/form-data` body are decoded through the same code path (Go's `net/http` parses either
one the same way once `ParseMultipartForm` has been called) - except a multipart `format: binary`
field, read via `r.FormFile` (an actual uploaded file part) rather than `r.PostForm` (a text form
value), since `application/x-www-form-urlencoded` has no file-part equivalent to parse that way.

### Path/query/header/cookie parameters

Same supported shapes as the client generator - see its README "Path/query/header/cookie
parameters" section. A required parameter that's absent, or any parameter that fails to parse into
its declared type, returns a `*models.ValidationError` before the handler is called, mapped to 400
by `DefaultErrorHandler`.

## Formatting generated sources

Templates emit tab-indented Go directly, readable without a formatter. For canonical `gofmt`
output, pass `-p`/`--post-process`:

```bash
openapi-yagen g -o out -g go_net_http_server_generator openapi.yaml \
    -v packageName=github.com/example/petstore \
    -p "go:gofmt -w %file%"
```

## Known limitations (v1)

- Request and response bodies support `application/json`, a single `text/*` media type (as
  `string`), and a single other media type (as `[]byte`); request bodies additionally support
  `application/x-www-form-urlencoded` and `multipart/form-data` (a `type: object` schema with
  scalar/enum properties or arrays of either; `multipart/form-data` also supports a `format: binary`
  file-upload property, read via `r.FormFile` - see "Request body content types"). A requestBody/
  response declaring two or more media types outside those fixed ones is a generator error. A nested
  object field (or an array of arrays/objects) in a urlencoded/multipart body is still a generator
  error.
- `Validate()` (called automatically on a JSON request body before the handler runs; recurses into
  nested struct/`oneOf`/`anyOf`-typed fields - see the client generator README's "Model types"
  section) has non-recursive checks limited to `minimum`/`maximum`/`minLength`/`maxLength`/
  `pattern`/`format: uuid`/`format: date` - no `multipleOf`, `minItems`/`maxItems`, `uniqueItems`,
  `minProperties`/`maxProperties`, or `additionalProperties: false` enforcement.
- Only `http`/`bearer`, `apiKey`, `oauth2`, and `openIdConnect` security schemes are supported (a
  `mutualTLS`/HTTP Basic scheme is a generator error); no token/scope validation is generated for
  any of them - just presence extraction, left to the handler implementation.
- `format: date` and `format: uuid` generate a plain `string`.
- Path/query/header/cookie parameters must resolve to a primitive scalar type, an enum, a `format:
  date-time` value, or a oneOf/anyOf whose every variant is itself primitive/enum-shaped - an
  object or array in one of those positions is a generator error (except a query array).
- Generated files are not run through a formatter by default - see "Formatting generated sources".

## Try it

From the `generators/` directory, with `openapi-yagen` on `PATH`:

```bash
cd generators && ./run_go_server.sh
```
generates into `generators/out/go-server` from `test/resources/petstore.yaml`.

For a generate-then-run check exercising every operation, positive and negative (validation,
missing-auth, not-found), see
[`test/`](https://github.com/openapi-yagen/openapi-yagen/tree/master/generators/go_net_http_server_generator/test).
