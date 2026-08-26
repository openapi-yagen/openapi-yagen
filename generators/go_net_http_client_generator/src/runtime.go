package client

import (
	"fmt"
	"net/url"
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

// ResponseError is returned when a request completes but the server responded with an
// unsuccessful (4xx/5xx) status code.
type ResponseError struct {
	StatusCode int
	Body       []byte
}

func (e *ResponseError) Error() string {
	return fmt.Sprintf("unexpected status %d: %s", e.StatusCode, string(e.Body))
}
