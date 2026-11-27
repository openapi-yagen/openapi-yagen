package client

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// formatParam converts a path/query/header parameter value to its wire string representation.
// time.Time is formatted as RFC3339 (fmt.Sprint's default time.Time formatting is not wire-safe);
// every other supported parameter type prints its natural wire value directly, including a
// generated enum type (its underlying string/int representation IS its wire value).
func formatParam(v any) string {
	if t, ok := v.(time.Time); ok {
		return t.Format(time.RFC3339)
	}
	return fmt.Sprint(v)
}

func pathParam(v any) string {
	return url.PathEscape(formatParam(v))
}

func addQueryParam(q url.Values, name string, v any) {
	q.Set(name, formatParam(v))
}

// OpenAPI 3's default array-typed query parameter serialization (`style: form, explode: true`):
// one repeated `name=` key per element, e.g. `?ids=1&ids=2` - not a single comma-joined value.
func addQueryParamList[T any](q url.Values, name string, values []T) {
	for _, v := range values {
		q.Add(name, formatParam(v))
	}
}

// Comma/space/pipe-joined single-value array query parameter serialization (OpenAPI's
// `explode: false`, style: form/spaceDelimited/pipeDelimited) - the counterpart to
// addQueryParamList's repeated-key form (explode: true).
func addQueryParamJoined[T any](q url.Values, name string, values []T, sep string) {
	if len(values) == 0 {
		return
	}
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = formatParam(v)
	}
	q.Set(name, strings.Join(parts, sep))
}

// writeMultipartFile writes a multipart `format: binary` field as an actual file part (via
// CreateFormFile) rather than a text field - name doubles as both the form field name and the
// part's filename, since the generated model only carries the file's bytes, not a separate
// filename. A nil data (an absent optional file field - []byte is never pointer-wrapped, see
// types.js's isRefType) writes nothing.
func writeMultipartFile(w *multipart.Writer, name string, data []byte) error {
	if data == nil {
		return nil
	}
	part, err := w.CreateFormFile(name, name)
	if err != nil {
		return err
	}
	_, err = part.Write(data)
	return err
}

// MaxErrorBodySize caps how many bytes of an unsuccessful response's body are read into
// ResponseError.Body. Set it before issuing requests.
var MaxErrorBodySize int64 = 64 << 10

// ResponseError is returned when a request completes but the server responded with an
// unsuccessful (4xx/5xx) status code, or a status the operation doesn't declare.
type ResponseError struct {
	StatusCode int
	// Body is the response body, truncated to MaxErrorBodySize.
	Body []byte
}

// Error reports the status only - the body may carry personal data or secrets, so it's left to the
// caller to decide what of it to log.
func (e *ResponseError) Error() string {
	return fmt.Sprintf("unexpected status %d", e.StatusCode)
}

// Auth supplies the credentials of operations that declare a security requirement. A func is called
// for every request that needs it, so it can return a refreshed value; scheme is the name of the
// securityScheme in the OpenAPI document. Leave a func nil if you have no credentials of its kind.
type Auth struct {
	// Bearer returns the token of an http/bearer, oauth2, or openIdConnect scheme, sent as
	// `Authorization: Bearer <token>`.
	Bearer func(ctx context.Context, scheme string) (string, error)
	// APIKey returns the value of an apiKey scheme, sent in the header, query parameter, or cookie
	// the scheme declares.
	APIKey func(ctx context.Context, scheme string) (string, error)
}

// Option configures a client.
type Option func(*clientOptions)

// WithAuth makes the client add credentials to every operation that declares a security
// requirement: the first of the operation's alternatives for which auth has all the needed funcs is
// used, and a request none of them covers fails before being sent. Without this option the client
// adds no credentials, leaving authentication to the *http.Client (e.g. its Transport).
func WithAuth(auth Auth) Option {
	return func(o *clientOptions) { o.auth = &auth }
}

type clientOptions struct {
	auth *Auth
}

func newClientOptions(opts []Option) clientOptions {
	var o clientOptions
	for _, opt := range opts {
		opt(&o)
	}
	return o
}

// securityRequirement is one securityScheme an operation needs: a bearer token, or else an apiKey
// sent as name in the location given by in.
type securityRequirement struct {
	scheme string
	bearer bool
	in     string
	name   string
}

func (a *Auth) source(requirement securityRequirement) func(context.Context, string) (string, error) {
	if requirement.bearer {
		return a.Bearer
	}
	return a.APIKey
}

func (a *Auth) covers(alternative []securityRequirement) bool {
	for _, requirement := range alternative {
		if a.source(requirement) == nil {
			return false
		}
	}
	return true
}

// authorize adds to req the credentials of the first alternative the configured Auth covers. If it
// covers none, the request is left as is when optional, and is an error otherwise.
func (o clientOptions) authorize(req *http.Request, optional bool, alternatives [][]securityRequirement) error {
	if o.auth == nil {
		return nil
	}
	for _, alternative := range alternatives {
		if !o.auth.covers(alternative) {
			continue
		}
		for _, requirement := range alternative {
			if err := o.auth.apply(req, requirement); err != nil {
				return err
			}
		}
		return nil
	}
	if optional {
		return nil
	}
	return errors.New("the configured Auth doesn't cover any of the operation's security requirements")
}

func (a *Auth) apply(req *http.Request, requirement securityRequirement) error {
	value, err := a.source(requirement)(req.Context(), requirement.scheme)
	if err != nil {
		return fmt.Errorf("credentials for security scheme %q: %w", requirement.scheme, err)
	}
	if value == "" {
		return fmt.Errorf("empty credentials for security scheme %q", requirement.scheme)
	}
	switch {
	case requirement.bearer:
		req.Header.Set("Authorization", "Bearer "+value)
	case requirement.in == "query":
		query := req.URL.Query()
		query.Set(requirement.name, value)
		req.URL.RawQuery = query.Encode()
	case requirement.in == "cookie":
		req.AddCookie(&http.Cookie{Name: requirement.name, Value: value})
	default:
		req.Header.Set(requirement.name, value)
	}
	return nil
}

// File is a raw (non-JSON, non-text) response body, still unread: stream it via Body, or call
// Bytes() to read it whole. Either way the caller must consume it - Bytes() closes Body itself,
// otherwise call Close() when done.
type File struct {
	// Body is the response body, read directly from the connection.
	Body io.ReadCloser
	// ContentType is the response's Content-Type header.
	ContentType string
	// ContentLength is the response's declared body length, or -1 if unknown.
	ContentLength int64
	// Name is the filename from a Content-Disposition response header, or "" if there is none.
	Name string
	// StatusCode is the actual response status (e.g. 206 for a partial Range response).
	StatusCode int
	// Header is the full set of response headers.
	Header http.Header
}

// Bytes reads the whole remaining body into memory and closes it.
func (f *File) Bytes() ([]byte, error) {
	defer f.Body.Close()
	return io.ReadAll(f.Body)
}

// Close closes the body without reading the rest of it.
func (f *File) Close() error { return f.Body.Close() }

func newFile(resp *http.Response) *File {
	f := &File{
		Body:          resp.Body,
		ContentType:   resp.Header.Get("Content-Type"),
		ContentLength: resp.ContentLength,
		StatusCode:    resp.StatusCode,
		Header:        resp.Header,
	}
	if disposition := resp.Header.Get("Content-Disposition"); disposition != "" {
		if _, params, err := mime.ParseMediaType(disposition); err == nil {
			f.Name = params["filename"]
		}
	}
	return f
}
