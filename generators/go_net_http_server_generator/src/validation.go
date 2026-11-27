package models

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"time"
)

// ValidationError reports a value that violates an OpenAPI schema constraint.
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("field %q: %s", e.Field, e.Message)
}

type numeric interface {
	~int | ~int32 | ~int64 | ~float32 | ~float64
}

func requireMin[T numeric](value *T, min float64, field string) error {
	if value != nil && float64(*value) < min {
		return &ValidationError{Field: field, Message: fmt.Sprintf("must be >= %v", min)}
	}
	return nil
}

func requireMax[T numeric](value *T, max float64, field string) error {
	if value != nil && float64(*value) > max {
		return &ValidationError{Field: field, Message: fmt.Sprintf("must be <= %v", max)}
	}
	return nil
}

func requireMinLength[S ~string](value *S, min int, field string) error {
	if value != nil && len(*value) < min {
		return &ValidationError{Field: field, Message: fmt.Sprintf("must have length >= %d", min)}
	}
	return nil
}

func requireMaxLength[S ~string](value *S, max int, field string) error {
	if value != nil && len(*value) > max {
		return &ValidationError{Field: field, Message: fmt.Sprintf("must have length <= %d", max)}
	}
	return nil
}

func requirePattern[S ~string](value *S, pattern string, field string) error {
	if value == nil {
		return nil
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return fmt.Errorf("field %q: invalid pattern %q: %w", field, pattern, err)
	}
	if !re.MatchString(string(*value)) {
		return &ValidationError{Field: field, Message: fmt.Sprintf("does not match pattern %s", pattern)}
	}
	return nil
}

// uuidPattern matches the canonical 8-4-4-4-12 hyphenated hex form (RFC 4122 section 3) -
// version/variant bits aren't checked, matching how minimum/maximum/pattern etc. are also shape
// checks only, not full semantic validation.
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func requireUUID[S ~string](value *S, field string) error {
	if value != nil && !uuidPattern.MatchString(string(*value)) {
		return &ValidationError{Field: field, Message: "must be a valid UUID"}
	}
	return nil
}

// requireDate checks format: date's RFC 3339 full-date form (YYYY-MM-DD) - format: date-time
// already maps to time.Time (see lib/types.js's primitiveGoType), so this only ever runs against a
// plain string property/field.
func requireDate[S ~string](value *S, field string) error {
	if value != nil {
		if _, err := time.Parse(time.DateOnly, string(*value)); err != nil {
			return &ValidationError{Field: field, Message: "must be a valid date (YYYY-MM-DD)"}
		}
	}
	return nil
}

// prefixValidationField rewraps a nested Validate() error (from a struct- or oneOf/anyOf-typed
// field, called recursively by a generated Validate() method) so its Field reports the full path
// from the outermost struct - e.g. "shapes[2].radius" instead of bare "radius" - by prepending
// prefix once per struct hop the error bubbles through. Passed through unchanged for any error
// that isn't (or doesn't wrap) a *ValidationError.
func prefixValidationField(err error, prefix string) error {
	var ve *ValidationError
	if errors.As(err, &ve) {
		return &ValidationError{Field: prefix + "." + ve.Field, Message: ve.Message}
	}
	return err
}

// requireProperty reports a required property that is absent from a decoded JSON object, or, unless
// nullAllowed, one that is explicitly null.
func requireProperty(fields map[string]json.RawMessage, name string, nullAllowed bool) error {
	raw, ok := fields[name]
	if !ok {
		return &ValidationError{Field: name, Message: "is required"}
	}
	if !nullAllowed && string(raw) == "null" {
		return &ValidationError{Field: name, Message: "must not be null"}
	}
	return nil
}

// splitProperties removes the declared properties from fields, leaving only the additional ones,
// and returns the removed ones re-encoded as a JSON object. Names are matched exactly, so an
// additional property differing from a declared one only in letter case stays an additional one.
func splitProperties(fields map[string]json.RawMessage, names ...string) ([]byte, error) {
	declared := make(map[string]json.RawMessage, len(names))
	for _, name := range names {
		if raw, ok := fields[name]; ok {
			declared[name] = raw
			delete(fields, name)
		}
	}
	return json.Marshal(declared)
}

// decodeAdditionalProperties decodes every one of fields into T - nil if there are none.
func decodeAdditionalProperties[T any](fields map[string]json.RawMessage) (map[string]T, error) {
	if len(fields) == 0 {
		return nil, nil
	}
	result := make(map[string]T, len(fields))
	for name, raw := range fields {
		var value T
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, fmt.Errorf("property %q: %w", name, err)
		}
		result[name] = value
	}
	return result, nil
}

// marshalWithAdditionalProperties marshals value, then adds the additional properties to the
// resulting JSON object. An additional property named like a declared one is ignored.
func marshalWithAdditionalProperties[T any](value any, additional map[string]T, declared ...string) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil || len(additional) == 0 {
		return raw, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	for name, item := range additional {
		if slices.Contains(declared, name) {
			continue
		}
		encoded, err := json.Marshal(item)
		if err != nil {
			return nil, err
		}
		fields[name] = encoded
	}
	return json.Marshal(fields)
}
