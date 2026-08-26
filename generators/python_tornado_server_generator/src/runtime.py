"""Shared runtime for generated Tornado server code - copied into the output package verbatim (no
per-spec substitution needed, same as ruby_faraday_client_generator's runtime.rb). Every generated
RequestHandler and model calls into this module instead of duplicating parameter-parsing/
constraint-checking logic per operation/model.

Part of this generator's answer to AGENTS.md's "a generator for a dynamically-typed target language
must generate its own runtime checks" convention: Python has no compiler to reject a wrong-shaped or
out-of-spec value the way the Kotlin/TypeScript generators' static types do for free.
"""

from __future__ import annotations

from typing import Any, Dict


def field(d: Dict[str, Any], key: str) -> Any:
    """Reads `d[key]`, defaulting to None if absent - identical at runtime to `d.get(key)`, but
    typed to return plain Any rather than dict.get()'s inferred Optional[Any]. mypy --strict flags
    assigning "V | None" to a required (non-Optional) dataclass field even when V is already Any -
    routing through this one helper avoids that false positive in every generated from_wire without
    weakening any real type check elsewhere (a genuinely missing/null value is still caught by the
    generated validate() method's own required-field/type checks, unchanged)."""

    return d.get(key)


class ValidationError(Exception):
    """Raised when an incoming request parameter or body value fails validation - either a basic
    type check or an OpenAPI-level constraint (minLength/pattern/minimum/.../const). Deliberately
    generic and app-agnostic: integrating code maps this to whatever HTTP status/JSON body its own
    error-handling convention uses (e.g. tornado.web.HTTPError(422, ...) - see each generated
    RequestHandler, and the generator's README "Integrating the generated code")."""


def require_str(value: Any, field: str) -> None:
    if value is not None and not isinstance(value, str):
        raise ValidationError('"{}" has the wrong type: expected str, got {}'.format(field, type(value).__name__))


def require_int(value: Any, field: str) -> None:
    # bool is a subclass of int in Python - isinstance(True, int) is True - so it's excluded
    # explicitly here, otherwise a JSON `true` would silently pass an integer-typed field.
    if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
        raise ValidationError('"{}" has the wrong type: expected int, got {}'.format(field, type(value).__name__))


def require_float(value: Any, field: str) -> None:
    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
        raise ValidationError('"{}" has the wrong type: expected float, got {}'.format(field, type(value).__name__))


def require_bool(value: Any, field: str) -> None:
    if value is not None and not isinstance(value, bool):
        raise ValidationError('"{}" has the wrong type: expected bool, got {}'.format(field, type(value).__name__))


def require_const(value: Any, expected: Any, field: str) -> None:
    if value is not None and value != expected:
        raise ValidationError('"{}" must equal {!r}, got {!r}'.format(field, expected, value))


def require_min_length(value: Any, minimum: int, field: str) -> None:
    if value is not None and len(value) < minimum:
        raise ValidationError('"{}" must have length >= {}'.format(field, minimum))


def require_max_length(value: Any, maximum: int, field: str) -> None:
    if value is not None and len(value) > maximum:
        raise ValidationError('"{}" must have length <= {}'.format(field, maximum))


def require_pattern(value: Any, pattern: str, field: str) -> None:
    import re

    if value is not None and re.search(pattern, value) is None:
        raise ValidationError('"{}" does not match pattern {}'.format(field, pattern))


def require_min(value: Any, minimum: float, field: str) -> None:
    if value is not None and value < minimum:
        raise ValidationError('"{}" must be >= {}'.format(field, minimum))


def require_max(value: Any, maximum: float, field: str) -> None:
    if value is not None and value > maximum:
        raise ValidationError('"{}" must be <= {}'.format(field, maximum))


def require_exclusive_min(value: Any, minimum: float, field: str) -> None:
    if value is not None and value <= minimum:
        raise ValidationError('"{}" must be > {}'.format(field, minimum))


def require_exclusive_max(value: Any, maximum: float, field: str) -> None:
    if value is not None and value >= maximum:
        raise ValidationError('"{}" must be < {}'.format(field, maximum))


def require_multiple_of(value: Any, multiple: float, field: str) -> None:
    if value is not None and value % multiple != 0:
        raise ValidationError('"{}" must be a multiple of {}'.format(field, multiple))


def require_min_items(value: Any, minimum: int, field: str) -> None:
    if value is not None and len(value) < minimum:
        raise ValidationError('"{}" must have at least {} item(s)'.format(field, minimum))


def require_max_items(value: Any, maximum: int, field: str) -> None:
    if value is not None and len(value) > maximum:
        raise ValidationError('"{}" must have at most {} item(s)'.format(field, maximum))


def require_unique_items(value: Any, field: str) -> None:
    if value is not None:
        seen = []
        for item in value:
            if item in seen:
                raise ValidationError('"{}" must not contain duplicate items'.format(field))
            seen.append(item)


def require_min_properties(value: Any, minimum: int, field: str) -> None:
    if value is not None and len(value) < minimum:
        raise ValidationError('"{}" must have at least {} propert(y/ies)'.format(field, minimum))


def require_max_properties(value: Any, maximum: int, field: str) -> None:
    if value is not None and len(value) > maximum:
        raise ValidationError('"{}" must have at most {} propert(y/ies)'.format(field, maximum))


def parse_int(value: str, field: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValidationError('"{}" must be an integer, got {!r}'.format(field, value))


def parse_float(value: str, field: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ValidationError('"{}" must be a number, got {!r}'.format(field, value))


def parse_bool(value: str, field: str) -> bool:
    if value.lower() in ("true", "1"):
        return True
    if value.lower() in ("false", "0"):
        return False
    raise ValidationError('"{}" must be a boolean, got {!r}'.format(field, value))
