package models

import (
	"errors"
	"fmt"
	"regexp"
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

func requireMinLength(value *string, min int, field string) error {
	if value != nil && len(*value) < min {
		return &ValidationError{Field: field, Message: fmt.Sprintf("must have length >= %d", min)}
	}
	return nil
}

func requireMaxLength(value *string, max int, field string) error {
	if value != nil && len(*value) > max {
		return &ValidationError{Field: field, Message: fmt.Sprintf("must have length <= %d", max)}
	}
	return nil
}

func requirePattern(value *string, pattern string, field string) error {
	if value == nil {
		return nil
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return fmt.Errorf("field %q: invalid pattern %q: %w", field, pattern, err)
	}
	if !re.MatchString(*value) {
		return &ValidationError{Field: field, Message: fmt.Sprintf("does not match pattern %s", pattern)}
	}
	return nil
}

// uuidPattern matches the canonical 8-4-4-4-12 hyphenated hex form (RFC 4122 section 3) -
// version/variant bits aren't checked, matching how minimum/maximum/pattern etc. are also shape
// checks only, not full semantic validation.
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func requireUUID(value *string, field string) error {
	if value != nil && !uuidPattern.MatchString(*value) {
		return &ValidationError{Field: field, Message: "must be a valid UUID"}
	}
	return nil
}

// requireDate checks format: date's RFC 3339 full-date form (YYYY-MM-DD) - format: date-time
// already maps to time.Time (see lib/types.js's primitiveGoType), so this only ever runs against a
// plain string property/field.
func requireDate(value *string, field string) error {
	if value != nil {
		if _, err := time.Parse(time.DateOnly, *value); err != nil {
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
