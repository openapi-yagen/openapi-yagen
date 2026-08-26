package models

import (
	"fmt"
	"regexp"
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
