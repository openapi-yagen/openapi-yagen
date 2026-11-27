"""Shared runtime for the generated Tornado server code. Every generated RequestHandler and model
calls into this module instead of duplicating parameter-parsing/constraint-checking logic per
operation/model.

Values are type- and constraint-checked at runtime here, since Python has no compiler to reject a
wrong-shaped or out-of-spec value.
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass
from email.message import Message
from typing import Any, Dict, Optional


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


def bearer_token(header: Optional[str]) -> Optional[str]:
    """The token of an `Authorization: Bearer <token>` header value (the scheme name is
    case-insensitive) - None if the header is absent, uses another scheme, or carries no token."""

    if header is None:
        return None
    scheme, _, token = header.partition(" ")
    token = token.strip()
    return token if scheme.lower() == "bearer" and token else None


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


# Unlike parse_date_param/parse_datetime_param below, the error names no field: this is used for
# body properties, whose messages (like an enum's "invalid <Name> value") carry no per-field label.
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


class UnsupportedMediaTypeError(Exception):
    """Raised when a raw request body's Content-Type doesn't match the media type the operation
    declares - the generated route answers it with 415."""


def _media_type(value: str) -> str:
    return value.split(";", 1)[0].strip().lower()


def _media_type_matches(declared: str, actual: str) -> bool:
    if declared == "*/*":
        return True
    if declared.endswith("/*"):
        return actual.startswith(declared[:-1])
    return declared == actual


def read_binary_body(content_type: Optional[str], body: bytes, declared_media_type: str, required: bool) -> Optional[bytes]:
    """Checks a raw (non-JSON/form/text) request body against the operation's declared media type.
    A body sent without a Content-Type is treated as application/octet-stream (RFC 9110 section
    8.3). An empty body is None for an optional requestBody, a ValidationError for a required one."""
    if not body:
        if required:
            raise ValidationError("request body is required")
        return None
    actual = _media_type(content_type) if content_type else "application/octet-stream"
    if not _media_type_matches(_media_type(declared_media_type), actual):
        raise UnsupportedMediaTypeError(f"unsupported Content-Type {content_type!r}, expected {declared_media_type!r}")
    return body


@dataclass
class BinaryContent:
    """A raw (non-JSON, non-text) response body with optional metadata - return plain bytes instead
    when there's none to add."""

    data: bytes
    #: If set, sent as Content-Disposition: attachment; filename="name".
    name: Optional[str] = None
    #: Overrides the media type the operation declares for this response.
    content_type: Optional[str] = None


def _content_disposition(name: str) -> str:
    message = Message()
    message["Content-Disposition"] = "attachment"
    message.set_param("filename", name, header="Content-Disposition")
    return str(message["Content-Disposition"])


def write_binary(handler: Any, declared_media_type: str, value: Any) -> None:
    """Writes a raw response body (bytes or BinaryContent) through a tornado RequestHandler. A
    declared wildcard media type (e.g. "application/*") is sent as application/octet-stream unless
    BinaryContent.content_type overrides it."""
    content = value if isinstance(value, BinaryContent) else BinaryContent(data=value)
    content_type = content.content_type or ("application/octet-stream" if "*" in declared_media_type else declared_media_type)
    handler.set_header("Content-Type", content_type)
    if content.name:
        handler.set_header("Content-Disposition", _content_disposition(content.name))
    handler.write(content.data)
