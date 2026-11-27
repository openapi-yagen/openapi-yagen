---
title: Go net/http server generator
sidebar_label: Go net/http server
slug: /generators/go-net-http-server
description: Generate Go HTTP handlers on the standard library's net/http (Go 1.22+ ServeMux) and encoding/json, with no third-party dependencies.
---

# go_net_http_server

Generates a Go HTTP server using only the standard library (`net/http`'s Go 1.22+ method+wildcard
routing, `encoding/json`): one struct per OpenAPI schema in a `models` package, plus per OpenAPI
tag a handler interface and a `RegisterXRoutes` function in a `server` package.

The generated code never creates its own `*http.ServeMux` - `RegisterXRoutes` takes a
caller-supplied `server.Router` (any type with `*http.ServeMux`'s `HandleFunc` method, so a plain
`*http.ServeMux` works as-is) and an implementation of the handler interface. Incoming requests (path/query/header/cookie parameters
and, where constrained, the request body) are parsed and validated before the handler is called,
using shared helper functions in `server/runtime.go` instead of duplicating checks per operation.

## Usage

```bash
openapi-yagen g -o out -g builtin:go_net_http_server openapi.yaml \
    -v packageName=github.com/example/petstore
```

`packageName` is the Go import path of the `-o` directory. That directory can be the root of a Go
module (`-o out -v packageName=github.com/example/petstore`, after
`go mod init github.com/example/petstore`) or any subdirectory of an existing module, in which case
append the subdirectory to the module path:

```bash
# inside the module github.com/example/petstore
openapi-yagen g -o internal/api/gen -g builtin:go_net_http_server openapi.yaml \
    -v packageName=github.com/example/petstore/internal/api/gen
```

| Variable      | Required | Description |
|---------------|----------|-------------|
| `packageName` | yes      | Go import path of the `-o` directory (e.g. `github.com/example/petstore`, or `github.com/example/petstore/gen` when generating into `gen/`). Used to build the import statement `server` code needs to reference `models` - the `package` clause of every generated file is always the literal `models`/`server`, never this value. |
| `strict`      | no (default `true`) | `true`: an unsupported schema/operation aborts generation with an error. `false`: skip it with a printed warning and generate everything else. |
| `generate`    | no (default `all`) | `all`: models plus the server. `models`: only `models/*.go`. `api`: everything except `models/*.go` - see "Sharing models" below. |
| `publishOpenApiSpec` | no (default `false`) | `true`: generates `server/openapi.json` (the effective OpenAPI document - the one actually used to generate this code, after `$ref` resolution, `--tags` filtering, and conversion to this generator's OpenAPI 3.1) plus a `RegisterOpenApiSpecRoute` function serving it as JSON at `openApiSpecPath`, compiled into the binary via `go:embed`. Ignored when `generate` is `models`. |
| `openApiSpecPath` | no (default `/openapi.json`) | Only used when `publishOpenApiSpec` is `true`: the route path the spec is served at. |

## Output layout

```
models/<Name>.go          one file per schema (struct / enum / union / defined type)
server/<Tag>Handler.go    handler interface for one OpenAPI tag, one method per operation
server/RegisterXRoutes.go registers that tag's routes onto a server.Router; XRoutes() lists them
server/routes.go          Routes() - every tag's route list combined
server/runtime.go         parameter parsing/validation helpers, Router/Route, BinaryBody/File, error types,
                          ErrorHandler - rendered once
server/openapi.json       only if publishOpenApiSpec=true - the effective OpenAPI document
server/openapi_spec.go    only if publishOpenApiSpec=true - OpenAPISpec() and RegisterOpenApiSpecRoute,
                          embeds openapi.json
models/validation.go      ValidationError plus requireMin/requireMax/requireMinLength/requireMaxLength/requirePattern
models/union_helpers.go   internal helpers used by generated oneOf/anyOf wrapper types
```

## Sharing models with the client generator

`models/*.go` is the same output whether it comes from this generator or from
[`go_net_http_client`](../go_net_http_client_generator/README.md) - both generate into a
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

Routes are registered exactly as the spec's own `paths:` keys declare them (no prefix applied) -
you control the mount path by wrapping `mux` yourself (e.g. `http.StripPrefix("/v1", mux)`, or
registering `RegisterPetsRoutes` onto a sub-mux mounted under a prefix on an outer one) if the
spec's own `servers`/`basePath` implies one.

`RegisterXRoutes`'s third argument is an `ErrorHandler` (`func(w http.ResponseWriter, r *http.Request,
err error)`) called whenever parameter parsing, validation, authentication, or the handler method
itself returns an error - `nil` uses `server.DefaultErrorHandler`, which maps a
`*models.ValidationError` to 400, a `*server.MissingAuthenticationError` to 401, an
`*http.MaxBytesError` (a raw request body read past `BinaryBody.Limit`) to 413, a
`*server.UnsupportedMediaTypeError` (a raw request body with the wrong `Content-Type`) to 415, and
anything else to 500. Pass a custom `ErrorHandler` for a different error body shape, logging, or
request-ID correlation.

### Listing routes

Each tag also gets an `XRoutes() []server.Route` function listing the routes `RegisterXRoutes`
registers, and `server.Routes()` returns every tag's list combined - e.g. for logging the active
routes at startup:

```go
for _, route := range server.Routes() {
    log.Printf("%s %s (%s, tag %s)", route.Method, route.Path, route.OperationID, route.Tag)
}
```

`Route.Path` is the path template exactly as the spec declares it (`/pets/{petId}`);
`Route.OperationID` is empty for an operation without an `operationId`. `RegisterOpenApiSpecRoute`'s
route is not included.

Since `RegisterXRoutes` accepts any `server.Router`, you can also wrap the mux yourself to record,
instrument, or rewrite every registration:

```go
type loggingRouter struct{ mux *http.ServeMux }

func (l loggingRouter) HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request)) {
    log.Printf("registering %s", pattern)
    l.mux.HandleFunc(pattern, handler)
}

server.RegisterPetsRoutes(loggingRouter{mux}, &petsHandler{}, nil)
```

### Publishing the OpenAPI spec

Set `-v publishOpenApiSpec=true` to have the generated server publish its own spec:

```bash
openapi-yagen g -o out -g builtin:go_net_http_server openapi.yaml \
    -v packageName=github.com/example/petstore -v publishOpenApiSpec=true
```

This writes `server/openapi.json` - the *effective* document (after `$ref` resolution, `--tags`
filtering, and conversion to this generator's OpenAPI 3.1) - and `server/openapi_spec.go`, which
embeds it into the binary at compile time via `//go:embed` and exposes
`RegisterOpenApiSpecRoute(mux)`. Call it alongside your other `RegisterXRoutes` calls:

```go
mux := http.NewServeMux()
server.RegisterPetsRoutes(mux, &petsHandler{}, nil)
server.RegisterOpenApiSpecRoute(mux)
```

The same embedded bytes are available as data via `server.OpenAPISpec() []byte` - e.g. to inspect
the document at startup without an HTTP round-trip. The returned slice is shared; don't modify it.

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

See [`go_net_http_client`](../go_net_http_client_generator/README.md)'s README "Model
types" section - struct/enum/union/pointer representation is identical, since both generators
share the same `models` output.

### Request body content types

A request body's media type is picked in this order: `application/json` (decoded into the model
type, `Validate()`d before the handler runs), `multipart/form-data`, then
`application/x-www-form-urlencoded` (a flat `type: object` schema, one struct field per form
field), then the single remaining media type - `text/*` as `body string`, anything else as a raw
body (below). A `application/x-www-form-urlencoded` and a `multipart/form-data` body are decoded
through the same code path (Go's `net/http` parses either one the same way once
`ParseMultipartForm` has been called) - except a multipart `format: binary` field, read via
`r.FormFile` into a `[]byte` field (an actual uploaded file part) rather than `r.PostForm` (a text
form value), since `application/x-www-form-urlencoded` has no file-part equivalent.

#### Raw request bodies

Any other media type (`application/octet-stream`, `application/zip`, `image/png`, ...) reaches the
handler as `body *server.BinaryBody` - the request body still **unread**, so each handler
implementation decides per operation whether to buffer it or stream it:

```go
// Small payload: just take the bytes.
func (h *petsHandler) UploadPetAvatar(ctx context.Context, petId string, body *server.BinaryBody) error {
    data, err := body.Bytes()
    if err != nil {
        return err
    }
    return h.store.SaveAvatar(petId, data)
}

// Large payload: stream it straight to disk, capped at 1 GiB.
func (h *backupHandler) RestoreBackup(ctx context.Context, body *server.BinaryBody) error {
    body.Limit(1 << 30) // reading past it fails with *http.MaxBytesError -> 413
    f, err := os.CreateTemp("", "restore-*")
    if err != nil {
        return err
    }
    defer f.Close()
    _, err = io.Copy(f, body) // BinaryBody is an io.Reader
    return err
}
```

`BinaryBody` also exposes `ContentType` (the request's media type, without parameters),
`ContentLength` (-1 if unknown) and the request's `Header`.

Before the handler runs, the request's `Content-Type` is checked against the declared media type
(which may be a wildcard like `application/*` or `*/*`); a mismatch returns a
`*server.UnsupportedMediaTypeError`, mapped to 415 by `DefaultErrorHandler`. A body sent without
any `Content-Type` is treated as `application/octet-stream` (RFC 9110). An empty body for a
`required` requestBody is a `*models.ValidationError` (400); for an optional one, `body` is `nil`.

### Responses

A success response's body type follows its media type: `application/json` returns the model type
(written with `encoding/json`), a single `text/*` media type returns `string`, any other single
media type returns a `server.File`, and a response without content returns just `error`. The
response's status code is the one declared in the spec.

#### Raw response bodies (`server.File`)

```go
type File struct {
    Data        []byte    // the whole body, when already in memory - takes precedence over Content
    Content     io.Reader // streamed as the body when Data is nil; closed afterwards if it's an io.Closer
    Name        string    // if set: Content-Disposition: attachment; filename="Name"
    ModTime     time.Time // if set: Last-Modified, and used for conditional requests
    ContentType string    // overrides the declared media type
}
```

```go
// In memory:
return server.File{Data: pngBytes}, nil

// Streamed from disk, with Range support:
f, err := os.Open(path)
if err != nil {
    return server.File{}, err
}
st, _ := f.Stat()
return server.File{Content: f, Name: "backup.tar.gz", ModTime: st.ModTime()}, nil
```

For a 200 response, `Data` or an `io.ReadSeeker` `Content` (such as `*os.File`) is served through
`http.ServeContent`: `Content-Length`, `Range` requests (`206 Partial Content`), and
`If-Modified-Since`/`If-Range`/`If-None-Match` conditional requests are handled automatically. A
`206` response declared with the same media type as the operation's `200` is therefore not a
separate response the handler returns - `http.ServeContent` produces it. A non-seekable `Content`,
or any other status code, is copied to the response as-is. A declared wildcard media type (e.g.
`application/*`) is sent as `application/octet-stream` unless `ContentType` is set.

#### Multiple success responses

An operation declaring two or more `2xx` responses (e.g. `200` for a synchronous result and `202`
for an accepted background job) returns a sealed interface, with one struct per status code - the
handler picks the status by which one it returns:

```go
// Generated:
type CreateBackupResponse interface{ isCreateBackupResponse() }
type CreateBackup200Response struct{ Body File }            // 200, application/zip
type CreateBackup202Response struct{ Body models.Operation } // 202, application/json
type CreateBackup204Response struct{}                        // a response without content

// Implementation:
func (h *backupHandler) CreateBackup(ctx context.Context, sync *bool) (server.CreateBackupResponse, error) {
    if sync != nil && *sync {
        f, err := h.buildNow(ctx)
        if err != nil {
            return nil, err
        }
        return server.CreateBackup200Response{Body: server.File{Content: f, Name: "backup.tar"}}, nil
    }
    return server.CreateBackup202Response{Body: h.startInBackground()}, nil
}
```

Each variant's `Body` follows the same media type rules as a single response. Return the variant
by value (not a pointer); `nil` or any other value is reported to the `ErrorHandler` (500 with
`DefaultErrorHandler`). An operation with a single success response keeps the plain `(T, error)`
signature.

### Path/query/header/cookie parameters

Same supported shapes as the client generator - see its README "Path/query/header/cookie
parameters" section. A required parameter that's absent, or any parameter that fails to parse into
its declared type, returns a `*models.ValidationError` before the handler is called, mapped to 400
by `DefaultErrorHandler`.

## Formatting generated sources

Templates emit tab-indented Go directly, readable without a formatter. For canonical `gofmt`
output, pass `-p`/`--post-process`:

```bash
openapi-yagen g -o out -g builtin:go_net_http_server openapi.yaml \
    -v packageName=github.com/example/petstore \
    -p "go:gofmt -w %file%"
```

## Known limitations (v1)

- Request and response bodies support `application/json`, a single `text/*` media type (as
  `string`), and a single other media type (as `*server.BinaryBody` / `server.File`); request
  bodies additionally support `application/x-www-form-urlencoded` and `multipart/form-data` (a
  `type: object` schema with scalar/enum properties or arrays of either; `multipart/form-data` also
  supports a `format: binary` file-upload property, read via `r.FormFile` - see "Request body
  content types"). A requestBody/response declaring two or more media types outside those fixed
  ones is a generator error. A nested object field (or an array of arrays/objects) in a
  urlencoded/multipart body is still a generator error.
- A multipart `format: binary` file part is read fully into memory as `[]byte` - only a raw
  (non-form) request body is streamed.
- Only explicitly numbered `2xx` responses become separate response variants; a range (`2XX`) or
  `default` response is used only when no numbered `2xx` response exists. Response headers declared
  in the spec are not generated - set them in middleware wrapping the mux.
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
