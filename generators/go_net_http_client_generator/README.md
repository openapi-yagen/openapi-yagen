---
title: Go net/http client generator
sidebar_label: Go net/http client
slug: /generators/go-net-http-client
description: Generate a Go API client on the standard library's net/http and encoding/json, with no third-party dependencies.
---

# go_net_http_client

Generates a Go API client using only the standard library (`net/http`, `encoding/json`): one
struct per OpenAPI schema in a `models` package, plus one client type per tag in a `client`
package with one method per operation.

The generated client never creates its own `*http.Client` or configures transport/auth - each tag
client takes a caller-supplied `*http.Client` and base URL in its constructor. Configure timeouts,
retries, and authentication (e.g. via a custom `http.RoundTripper`) on that `*http.Client` before
passing it in.

## Usage

```bash
openapi-yagen g -o out -g builtin:go_net_http_client openapi.yaml \
    -v packageName=github.com/example/petstore
```

`packageName` is the Go import path of the `-o` directory. That directory can be the root of a Go
module (`-o out -v packageName=github.com/example/petstore`, after
`go mod init github.com/example/petstore`) or any subdirectory of an existing module, in which case
append the subdirectory to the module path:

```bash
# inside the module github.com/example/petstore
openapi-yagen g -o internal/api/gen -g builtin:go_net_http_client openapi.yaml \
    -v packageName=github.com/example/petstore/internal/api/gen
```

| Variable      | Required | Description |
|---------------|----------|-------------|
| `packageName` | yes      | Go import path of the `-o` directory (e.g. `github.com/example/petstore`, or `github.com/example/petstore/gen` when generating into `gen/`). Used to build the import statement `client` code needs to reference `models` - the `package` clause of every generated file is always the literal `models`/`client`, never this value. |
| `strict`      | no (default `true`) | `true`: an unsupported schema/operation aborts generation with an error. `false`: skip it with a printed warning and generate everything else. |
| `generate`    | no (default `all`) | `all`: models plus the client. `models`: only `models/*.go`. `api`: everything except `models/*.go` - see "Sharing models" below. |

## Output layout

```
models/<Name>.go    one file per schema (struct / enum / union / defined type)
client/<Tag>Client.go   one client type per OpenAPI tag, one method per operation
client/ApiClient.go     bundles one instance of every tag client from a shared *http.Client/baseURL
client/runtime.go       small internal parameter-formatting helpers, copied once
models/validation.go    ValidationError plus requireMin/requireMax/requireMinLength/requireMaxLength/requirePattern
models/union_helpers.go internal helpers used by generated oneOf/anyOf wrapper types
```

## Sharing models with the server generator

`models/*.go` is the same output whether it comes from this generator or from
[`go_net_http_server`](../go_net_http_server_generator/README.md) - both generate into a
`models` package with the same template for every model kind, and neither's model files reference
anything client- or server-specific.

To generate models once and share them:

```bash
# shared models module
openapi-yagen g -o shared -g builtin:go_net_http_client openapi.yaml \
    -v packageName=github.com/example/petstore -v generate=models

# client module - client/ only, no models/
openapi-yagen g -o client -g builtin:go_net_http_client openapi.yaml \
    -v packageName=github.com/example/petstore -v generate=api

# server module - server/ only, no models/
openapi-yagen g -o server -g builtin:go_net_http_server openapi.yaml \
    -v packageName=github.com/example/petstore -v generate=api
```

All three must share the same `packageName` and use a `go.mod` `replace` directive (or a shared
module) so `client`/`server` resolve `models` to the same package.

## Integrating the generated code

```go
httpClient := &http.Client{Timeout: 10 * time.Second}
api := client.NewApiClient(httpClient, "https://petstore.example.com/v1")
pets, err := api.Pets.ListPets(ctx, nil, nil)
```

Each tag's client type (`PetsClient`, `WidgetsClient`, ...) can also be instantiated directly if
only one is needed - `ApiClient` is just a convenience bundle:

```go
petsClient := client.NewPetsClient(httpClient, "https://petstore.example.com/v1")
```

A response with a 4xx/5xx status code is returned as a `*client.ResponseError` (`StatusCode`,
`Body`), not decoded as a successful response.

### Model types

Every generated struct has a `Validate() error` method checking its own declared constraints
(`minimum`/`maximum`/`minLength`/`maxLength`/`pattern`/`format: uuid`/`format: date`) - it is not
called automatically; call it explicitly wherever validation is needed. It also recurses into any
struct- or `oneOf`/`anyOf`-typed field (directly, a `oneOf`/`anyOf` wrapper's `Validate()` delegates
to whichever variant is actually set, or through every element of a slice/map - including through a
named array/map alias like a top-level `type: array` schema) by calling that field's own
`Validate()`. A nested error's `Field` is rewritten to the full path from the outermost struct (e.g.
`"tags[2].name"`), one path segment per struct hop.

A property that is optional or nullable becomes a pointer field (`*T`) with a `,omitempty` JSON
tag when optional; a required, non-nullable property is a plain value field. Go's `encoding/json`
cannot distinguish an absent field from an explicit `null` for a pointer field - both decode to
`nil` - **except** for a property with a declared `default` (see below), where the two are
distinguished on purpose.

A `string`/`int`/`int32`/`int64`/`float32`/`float64`/`bool`/enum-typed property with a declared
`default` gets it applied whenever the wire key is absent - a generated `UnmarshalJSON` on the
struct pre-fills that field with the default before decoding over it, so an absent key leaves the
default in place while an explicit JSON `null` still overwrites it back to `nil` (encoding/json
always sets a destination to the zero value for an explicit `null`, even a pre-populated one - the
same behavior `null` already gets on every other field). `default` on any other property type
(`format: date-time`, an array/map/object/`oneOf`/`anyOf` property) has no effect - applying it
would need real value construction, not a single Go literal, and is comparatively rare in practice
for those types.

A `oneOf`/`anyOf` schema generates a wrapper struct with one `AsX()`/`FromX()` accessor pair per
variant and its own `MarshalJSON`/`UnmarshalJSON`:

```go
var shape models.Shape
if err := json.Unmarshal(data, &shape); err != nil { ... }
if circle, ok := shape.AsCircle(); ok {
    // ...
}
```

A discriminated union (`discriminator.propertyName` set, every variant a `$ref`) dispatches on the
discriminator property's value. An undiscriminated one dispatches on the raw JSON value's shape -
generation fails if the variants can't be unambiguously told apart this way (e.g. two object
variants with no property that distinguishes them).

An enum schema generates a defined string/int type with one constant per value, an `IsValid()
bool` method, and `MarshalJSON`/`UnmarshalJSON` that reject an unrecognized value.

`format: date-time` properties/parameters generate `time.Time`. `format: date` and `format: uuid`
generate a plain `string` - there is no dependency-free stdlib type for either - but a struct
property (not a path/query/header/cookie parameter) with one of those formats is still shape-checked by
`Validate()`: `format: uuid` requires the canonical 8-4-4-4-12 hyphenated hex form, `format: date`
requires `YYYY-MM-DD`.

### Request body content types

Request-body content types are picked from whichever the spec declares, in priority order
`application/json` > `multipart/form-data` > `application/x-www-form-urlencoded` > a single
remaining media type (sent as `string` if `text/*`, streamed from an `io.Reader` otherwise). The first three build the
same generated model struct as the `body` parameter - only how it's sent over the wire differs:

- **`application/json`** (default): `Content-Type: application/json`, JSON-encoded body.
- **`application/x-www-form-urlencoded`**: one `url.Values` entry per property, sent as
  `Content-Type: application/x-www-form-urlencoded`. The schema must be `type: object` with only
  scalar/enum properties, or an array of either (sent as a repeated form key, e.g.
  `tags=a&tags=b` - OpenAPI's default `style: form, explode: true`) - a nested object field, or an
  array of arrays/objects, is a generator error.
- **`multipart/form-data`**: same property-shape restriction (including arrays) as
  `application/x-www-form-urlencoded`, sent via `mime/multipart` instead - **with one difference**:
  a `type: string, format: binary` property becomes a Go `[]byte` field (not `string`) and is sent
  as an actual uploaded file part (`multipart.Writer.CreateFormFile`), using the field's own wire
  name as both the form field name and the file's `filename` (there's no separate place in the
  model to carry a caller-chosen filename).
- **any single `text/*` media type**: `body string`, sent with the exact declared media type as
  `Content-Type` (not a generic `text/plain`).
- **any single other remaining media type**: `body io.Reader`, streamed as the request body without
  buffering, with the declared media type as `Content-Type` (a wildcard like `application/*` is sent
  as `application/octet-stream`). Pass `bytes.NewReader(data)` for data already in memory, or an
  `*os.File` to upload a file straight from disk. `nil` omits an optional body. The declared
  schema's `format` has no bearing here - the wire content-type alone decides `string` vs. raw.

### Responses

A success response's body type follows its media type: `application/json` decodes into the model
type, a single `text/*` media type returns `string`, any other single media type returns a
`*client.File`, and a response without content returns just `error`.

#### Raw response bodies (`*client.File`)

A `*client.File` hands you the response body **still unread**, so you choose per call whether to
buffer or stream it:

```go
// Small payload: read it whole (Bytes() also closes the body).
file, err := api.Pets.GetPetAvatar(ctx, "1")
if err != nil {
    return err
}
data, err := file.Bytes()

// Large payload: stream it to disk - you must Close() it yourself.
file, err := api.Backups.DownloadBackup(ctx, id)
if err != nil {
    return err
}
defer file.Close()
out, _ := os.Create(file.Name) // Name comes from Content-Disposition, "" if absent
_, err = io.Copy(out, file.Body)
```

`File` also carries `ContentType`, `ContentLength` (-1 if unknown), `StatusCode` (e.g. 206 for a
partial response) and the full response `Header`. A `206` response declared with the same media
type as the operation's `200` is returned the same way, as a `*File`.

#### Multiple success responses

An operation declaring two or more `2xx` responses (e.g. `200` for a synchronous result and `202`
for an accepted background job) returns a sealed interface with one struct per status code, picked
by the actual response status:

```go
// Generated:
type CreateBackupResponse interface{ isCreateBackupResponse() }
type CreateBackup200Response struct{ Body *File }            // 200, application/zip
type CreateBackup202Response struct{ Body models.Operation } // 202, application/json
type CreateBackup204Response struct{}                        // a response without content

// Usage:
resp, err := api.Backups.CreateBackup(ctx, &sync)
if err != nil {
    return err
}
switch r := resp.(type) {
case client.CreateBackup200Response:
    defer r.Body.Close()
    // stream r.Body.Body ...
case client.CreateBackup202Response:
    log.Printf("backup job %s started", r.Body.Id)
}
```

A `2xx` status the operation doesn't declare is returned as a `*client.ResponseError`. An operation
with a single success response keeps the plain `(T, error)` signature.

A requestBody/response declaring two or more media types outside the ones above is a generator
error.

### Path/query/header/cookie parameters

`in: path`/`query`/`header`/`cookie` are all supported. Must resolve to a primitive scalar type
(string/integer/number/boolean), a `format: date-time` value, an enum, or a `oneOf`/`anyOf` whose
every variant is itself primitive/enum-shaped (passed through as a plain, unparsed `string`) - an
object or array in one of those positions is a generator error, except a query parameter whose
schema is itself an array - path/header/cookie positions have no standard "repeated value"
serialization, so those stay scalar-only. An array-typed query parameter supports all three OpenAPI
3 serialization styles: `style: form` (default) with `explode: true` (the OpenAPI default - a
repeated key, `?name=a&name=b`) or `explode: false` (comma-joined, `?name=a,b`), `spaceDelimited`
(space-joined), and `pipeDelimited` (pipe-joined, `?name=a|b`) - any other `style` is a generator
error. A cookie parameter is sent via `http.Request.AddCookie`/read via `http.Request.Cookie` - not
the raw `Cookie` header directly.

## Formatting generated sources

Templates emit tab-indented Go directly, readable without a formatter. For canonical `gofmt`
output, pass `-p`/`--post-process`:

```bash
openapi-yagen g -o out -g builtin:go_net_http_client openapi.yaml \
    -v packageName=github.com/example/petstore \
    -p "go:gofmt -w %file%"
```

## Known limitations (v1)

- Request and response bodies support `application/json`, a single `text/*` media type (as
  `string`), and a single other media type (as `io.Reader` / `*client.File`); request bodies additionally support
  `application/x-www-form-urlencoded` and `multipart/form-data` (a `type: object` schema with
  scalar/enum properties or arrays of either; `multipart/form-data` also supports a `format: binary`
  file-upload property - see "Request body content types"). A requestBody/response declaring two or
  more media types outside those fixed ones is a generator error (aborts generation under default
  `strict=true`; skips just that operation with a printed warning under `-v strict=false`). A nested
  object field (or an array of arrays/objects) in a urlencoded/multipart body is still a generator
  error - there's no standard multipart/urlencoded convention for either, unlike a repeated scalar
  key.
- A multipart file-upload field always uses its own wire name as the uploaded part's `filename` -
  no way for a caller to choose a different one.
- `Validate()`'s own (non-recursive) checks are limited to `minimum`/`maximum`/`minLength`/
  `maxLength`/`pattern`/`format: uuid`/`format: date` - no `multipleOf`, `minItems`/`maxItems`,
  `uniqueItems`, `minProperties`/`maxProperties`, or `additionalProperties: false` enforcement.
- Go's `encoding/json` cannot distinguish an absent field from an explicit JSON `null` for a
  pointer field - both decode to `nil` - except a property with a declared `default` (see "Model
  types"), where the two are deliberately told apart.
- `default` is only applied for a `string`/`int`/`int32`/`int64`/`float32`/`float64`/`bool`/enum
  property - not `format: date-time`, an array/map/object property, or a `oneOf`/`anyOf` property.
- `format: date` and `format: uuid` generate a plain `string`.
- Path/query/header/cookie parameters must resolve to a primitive scalar type, an enum, a `format:
  date-time` value, or a oneOf/anyOf whose every variant is itself primitive/enum-shaped - an
  object or array in one of those positions is a generator error (except a query array, see
  "Path/query/header/cookie parameters").
- Generated files are not run through a formatter by default - see "Formatting generated sources".

## Try it

From the `generators/` directory, with `openapi-yagen` on `PATH`:

```bash
cd generators && ./run_go_client.sh
```
generates into `generators/out/go-client` from `test/resources/petstore.yaml`.

For a generate-then-run check exercising every operation, positive and negative, see
[`test/`](https://github.com/openapi-yagen/openapi-yagen/tree/master/generators/go_net_http_client_generator/test).
