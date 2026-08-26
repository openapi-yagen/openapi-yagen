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
an implementation of the handler interface. Incoming requests (path/query/header parameters and,
where constrained, the request body) are parsed and validated before the handler is called, using
shared helper functions in `server/runtime.go` instead of duplicating checks per operation.

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

Only `http`/`bearer` and `apiKey` security schemes are supported. A secured operation's handler
method gets one extra `string` parameter per required scheme, already extracted and validated
before the handler runs:

```go
func (h *petsHandler) DeletePet(ctx context.Context, petId string, bearerAuthToken string) error
```

A missing credential returns a `*server.MissingAuthenticationError` from `RegisterXRoutes`'s
wrapper before the handler is ever called, mapped to 401 by `DefaultErrorHandler`. A security
requirement with two or more OR-alternatives (`security: [{a: []}, {b: []}]`) is a generator error
- only a single combination of schemes (`security: [{a: [], b: []}]`, meaning both required
together) is supported. `oauth2`/`openIdConnect` schemes are also a generator error.

### Model types

See [`go_net_http_client_generator`](../go_net_http_client_generator/README.md)'s README "Model
types" section - struct/enum/union/pointer representation is identical, since both generators
share the same `models` output.

### Request body content types

Same priority order and restrictions as the client generator - see its README "Request body
content types" section. Server-side, a `application/x-www-form-urlencoded` and a
`multipart/form-data` body are decoded through the same code path (Go's `net/http` parses either
one the same way once `ParseMultipartForm` has been called).

### Path/query/header parameters

Same supported shapes as the client generator - see its README "Path/query/header parameters"
section. A required parameter that's absent, or any parameter that fails to parse into its
declared type, returns a `*models.ValidationError` before the handler is called, mapped to 400 by
`DefaultErrorHandler`.

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
  `application/x-www-form-urlencoded` and `multipart/form-data`. A requestBody/response declaring
  two or more media types outside those fixed ones is a generator error.
- `Validate()` (called automatically on a JSON request body before the handler runs) checks only
  `minimum`/`maximum`/`minLength`/`maxLength`/`pattern` and does not recurse into nested model
  fields.
- Only `http`/`bearer` and `apiKey` security schemes are supported; a security requirement with
  two or more OR-alternatives is a generator error.
- `format: date` and `format: uuid` generate a plain `string`.
- Path/query/header parameters must resolve to a primitive scalar type, an enum, a `format:
  date-time` value, or a oneOf/anyOf whose every variant is itself primitive/enum-shaped - an
  object or array in one of those positions is a generator error.
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
