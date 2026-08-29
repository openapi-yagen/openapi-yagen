"""Shared runtime for generated Tornado server code - copied into the output package verbatim (no
per-spec substitution needed, same as ruby_faraday_client_generator's runtime.rb). Every generated
RequestHandler and model calls into this module instead of duplicating parameter-parsing/
constraint-checking logic per operation/model.

Part of this generator's answer to AGENTS.md's "a generator for a dynamically-typed target language
must generate its own runtime checks" convention: Python has no compiler to reject a wrong-shaped or
out-of-spec value the way the Kotlin/TypeScript generators' static types do for free.
"""

from __future__ import annotations

import datetime
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


class MissingAuthenticationError(Exception):
    """Raised when an operation's required security-scheme credentials (a bearer token or apiKey)
    are absent from the request - deliberately NOT a ValidationError (a subclass or otherwise):
    this means "you haven't authenticated", not "your request is malformed", so each generated
    RequestHandler maps it to a distinct HTTP status (401) rather than ValidationError's 422."""


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


def require_bytes(value: Any, field: str) -> None:
    if value is not None and not isinstance(value, bytes):
        raise ValidationError('"{}" has the wrong type: expected bytes, got {}'.format(field, type(value).__name__))


def require_date(value: Any, field: str) -> None:
    if value is not None and not isinstance(value, datetime.date):
        raise ValidationError('"{}" has the wrong type: expected date, got {}'.format(field, type(value).__name__))


def require_datetime(value: Any, field: str) -> None:
    if value is not None and not isinstance(value, datetime.datetime):
        raise ValidationError('"{}" has the wrong type: expected datetime, got {}'.format(field, type(value).__name__))


# Canonical 8-4-4-4-12 hyphenated hex form (RFC 4122 section 3) - version/variant bits aren't
# checked, matching how require_max/require_max_length/require_pattern above are also shape checks
# only, not full semantic validation. `format: date`/`date-time` need no analogous check here:
# they're already typed as datetime.date/datetime.datetime (see primitiveDescriptor in types.js),
# so parse_date/parse_datetime below already reject a malformed value at from_wire time - a plain
# str property/parameter never happens for format: date/date-time the way it still does for
# format: uuid.
def require_uuid(value: Any, field: str) -> None:
    import re

    if value is not None and re.match(
        r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", value
    ) is None:
        raise ValidationError('"{}" must be a valid UUID'.format(field))


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


def _normalize_z_suffix(value: str) -> str:
    # datetime.fromisoformat() only started accepting a bare "Z" UTC designator in Python 3.11 -
    # normalizing it to "+00:00" ourselves keeps format: date-time parsing correct on any
    # supported Python version, not just 3.11+, since a real-world API's date-time values
    # virtually always use "Z" (RFC 3339's preferred form), not "+00:00".
    return value[:-1] + "+00:00" if value.endswith("Z") else value


# `field` is omitted here (unlike parse_date_param/parse_datetime_param below) to match the
# generated enum from_wire's own unlabeled "invalid <Name> value" message (see models.py.j2) -
# buildFromWireExpr (serialization.js) has no per-field label to thread through at body-property
# position, only scalarParamType (operations.js) does, for a path/query/header parameter.
def parse_date(value: str) -> datetime.date:
    try:
        return datetime.date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValidationError("invalid date value: {!r}".format(value))


def parse_datetime(value: str) -> datetime.datetime:
    try:
        return datetime.datetime.fromisoformat(_normalize_z_suffix(value))
    except (TypeError, ValueError):
        raise ValidationError("invalid date-time value: {!r}".format(value))


def parse_date_param(value: str, field: str) -> datetime.date:
    try:
        return datetime.date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValidationError('"{}" must be a valid date (YYYY-MM-DD), got {!r}'.format(field, value))


def parse_datetime_param(value: str, field: str) -> datetime.datetime:
    try:
        return datetime.datetime.fromisoformat(_normalize_z_suffix(value))
    except (TypeError, ValueError):
        raise ValidationError('"{}" must be a valid date-time (ISO 8601), got {!r}'.format(field, value))
