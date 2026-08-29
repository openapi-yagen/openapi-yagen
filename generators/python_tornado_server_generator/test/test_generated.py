"""Regenerates the kitchen-sink package via the real openapi-yagen CLI, then actually boots and
drives the generated Tornado routes - not just a syntax/import check. Same "generate, then actually
run the generated code" bar as this collection's Kotlin/TypeScript generator test suites (see
../../README.md).

OPENAPI_YAGEN points this at a prebuilt binary; without it, falls back to this checkout's own
dist/openapi-yagen (build it first - ./build-musl.sh or a local `cmake --build`).
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import pytest
from tornado.testing import AsyncHTTPTestCase
from tornado.web import HTTPError

HERE = Path(__file__).resolve().parent
GENERATOR_SRC = HERE.parent / "src"
SPEC = HERE / "resources" / "kitchensink.yaml"
REPO_ROOT = HERE.parents[2]
DEFAULT_BINARY = REPO_ROOT / "dist" / "openapi-yagen"

_tmp_dir = tempfile.TemporaryDirectory(prefix="python_tornado_server_generator_test_")
OUT_DIR = Path(_tmp_dir.name)
PACKAGE_NAME = "kitchensink_api"


def _openapi_yagen_binary() -> str:
    import os

    return os.environ.get("OPENAPI_YAGEN", str(DEFAULT_BINARY))


def _generate() -> None:
    binary = _openapi_yagen_binary()
    result = subprocess.run(
        [
            binary,
            "generate",
            str(SPEC),
            "-o",
            str(OUT_DIR),
            "-g",
            str(GENERATOR_SRC),
            "-v",
            f"packageName={PACKAGE_NAME}",
            "-c",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"generation failed (exit {result.returncode}):\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")


_generate()
sys.path.insert(0, str(OUT_DIR))

from kitchensink_api.apis.widgets import WidgetsHandler, build_widgets_routes  # noqa: E402
from kitchensink_api.models import (  # noqa: E402
    Circle,
    ErrorResponse,
    NewWidget,
    NewWidgetVisibility,
    Shape,
    Square,
    Widget,
    WidgetPhotoUpload,
    WidgetStatus,
    WidgetSubscription,
    WidgetVariant,
    WidgetVariantA,
    WidgetVariantB,
)
from kitchensink_api.runtime import MissingAuthenticationError, ValidationError  # noqa: E402


def _multipart_body(fields: Dict[str, str], files: Optional[Dict[str, bytes]] = None) -> tuple[str, bytes]:
    """Hand-rolls a minimal multipart/form-data body - no mocking library, same "stub the wire
    format by hand" convention this project's other generators' test suites use. A `files` entry
    gets a `filename=` in its Content-Disposition - what actually makes Tornado route it into
    self.request.files instead of self.request.body_arguments (see runtime.py/operations.js's
    buildRequestBody), unlike a plain `fields` entry."""
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode("utf-8"))
    for name, content in (files or {}).items():
        header = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="upload.bin"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        )
        parts.append(header.encode("utf-8") + content + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return f"multipart/form-data; boundary={boundary}", b"".join(parts)


class FakeWidgetsHandler(WidgetsHandler):
    def __init__(self) -> None:
        self.widgets: Dict[int, Widget] = {
            1: Widget(id=1, name="Alpha", owner="alice", note=None, labels={"color": "red"}, status=WidgetStatus.AVAILABLE),
            2: Widget(id=2, name="Beta", owner="bob", note="fragile", labels={}, status=WidgetStatus.PENDING),
        }
        self._next_id = 3
        self.uploaded_photos: Dict[int, WidgetPhotoUpload] = {}
        self.subscriptions: Dict[int, WidgetSubscription] = {}
        self.last_seen_session_id: Optional[str] = None

    def list_widgets(
        self, *, owner: Optional[str], status: Optional[WidgetStatus], tags: List[str], session_id: Optional[str]
    ) -> List[Widget]:
        self.last_seen_session_id = session_id
        result = list(self.widgets.values())
        if owner is not None:
            result = [w for w in result if w.owner == owner]
        if status is not None:
            result = [w for w in result if w.status == status]
        return result

    def create_widget(self, *, x_request_id: str, body: NewWidget) -> Widget:
        widget = Widget(
            id=self._next_id, name=body.name, owner=body.owner, note=body.note, labels=body.labels, status=body.status, variant=body.variant
        )
        self.widgets[self._next_id] = widget
        self._next_id += 1
        return widget

    def get_widget_by_id(self, *, widget_id: int) -> Widget:
        widget = self.widgets.get(widget_id)
        if widget is None:
            raise HTTPError(404, reason="no widget with this ID")
        return widget

    def delete_widget(self, *, widget_id: int, bearer_auth_token: str) -> None:
        self.widgets.pop(widget_id, None)

    def favorite_widget(self, *, widget_id: int, oauth_2_auth_token: Optional[str], api_key_auth_key: Optional[str]) -> None:
        pass

    def archive_widget(
        self, *, widget_id: int, api_key_auth_key: Optional[str], oauth_2_auth_token: Optional[str], bearer_auth_token: Optional[str]
    ) -> None:
        pass

    def upload_widget_photo(self, *, widget_id: int, body: WidgetPhotoUpload) -> None:
        self.uploaded_photos[widget_id] = body

    def subscribe_to_widget(self, *, widget_id: int, body: WidgetSubscription) -> None:
        self.subscriptions[widget_id] = body

    def get_shape_by_id(self, *, shape_id: str) -> Shape:
        return Circle(shape_type="circle", radius=2.5)

    def reset_widgets(self) -> None:
        self.widgets.clear()

    def export_widgets(self, *, api_key_auth_key: str) -> bytes:
        return b"WIDGET-ARCHIVE"

    def health_check(self) -> str:
        return "OK"


class GeneratedTornadoAppTest(AsyncHTTPTestCase):
    def get_app(self):
        import tornado.web

        self.handler_impl = FakeWidgetsHandler()
        return tornado.web.Application(build_widgets_routes(self.handler_impl))

    def test_list_widgets_returns_json_array(self) -> None:
        response = self.fetch("/widgets")
        assert response.code == 200
        assert response.headers["Content-Type"] == "application/json"
        body = json.loads(response.body)
        assert isinstance(body, list)
        assert len(body) == 2
        assert {w["name"] for w in body} == {"Alpha", "Beta"}

    def test_list_widgets_filters_by_owner_query_param(self) -> None:
        response = self.fetch("/widgets?owner=alice")
        assert response.code == 200
        body = json.loads(response.body)
        assert len(body) == 1
        assert body[0]["owner"] == "alice"

    def test_list_widgets_filters_by_enum_status_query_param(self) -> None:
        response = self.fetch("/widgets?status=pending")
        assert response.code == 200
        body = json.loads(response.body)
        assert len(body) == 1
        assert body[0]["name"] == "Beta"

    def test_list_widgets_invalid_enum_status_is_422(self) -> None:
        response = self.fetch("/widgets?status=not-a-status")
        assert response.code == 422

    def test_list_widgets_array_query_param(self) -> None:
        response = self.fetch("/widgets?tags=a&tags=b")
        assert response.code == 200
        assert len(json.loads(response.body)) == 2

    # Wired from the spec's `in: cookie` session_id parameter - proves buildParam's cookie branch
    # actually reads self.get_cookie(name), not the query string it used to be silently misrouted
    # into (a confirmed bug - see operations.js's buildParam).
    def test_list_widgets_reads_the_session_id_cookie_parameter(self) -> None:
        response = self.fetch("/widgets", headers={"Cookie": "session_id=abc123"})
        assert response.code == 200
        assert self.handler_impl.last_seen_session_id == "abc123"

    def test_list_widgets_without_the_session_id_cookie_leaves_it_none(self) -> None:
        response = self.fetch("/widgets")
        assert response.code == 200
        assert self.handler_impl.last_seen_session_id is None

    def test_create_widget_success(self) -> None:
        payload = json.dumps({"name": "Gamma", "owner": "carol", "labels": {}, "status": "available"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 201
        body = json.loads(response.body)
        assert body["name"] == "Gamma"
        assert body["owner"] == "carol"
        assert body["note"] is None
        assert body["status"] == "available"

    def test_create_widget_with_union_variant(self) -> None:
        payload = json.dumps(
            {"name": "Gamma", "owner": "carol", "labels": {}, "variant": {"kind": "x", "value": 7}}
        ).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 201
        body = json.loads(response.body)
        assert body["variant"] == {"kind": "x", "value": 7}

    def test_create_widget_missing_required_header_is_422(self) -> None:
        payload = json.dumps({"name": "Gamma", "owner": "carol"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload)
        assert response.code == 422

    # format: uuid validation - runtime.require_uuid (see serialization.js's buildValidateStatements).
    def test_create_widget_with_an_invalid_sku_uuid_is_422(self) -> None:
        payload = json.dumps({"name": "Gamma", "owner": "carol", "sku": "not-a-uuid"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 422

    def test_create_widget_with_a_valid_sku_uuid_returns_201(self) -> None:
        payload = json.dumps({"name": "Gamma", "owner": "carol", "sku": str(uuid.uuid4())}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 201

    # format: date/date-time - a real datetime.date/datetime.datetime type; the parse from_wire
    # does IS the validation (see runtime.parse_date/parse_datetime), same design as this project's
    # Kotlin server generator.
    def test_create_widget_with_an_invalid_manufactured_on_date_is_422(self) -> None:
        payload = json.dumps({"name": "Gamma", "owner": "carol", "manufacturedOn": "not-a-date"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 422

    def test_create_widget_with_a_valid_manufactured_on_date_returns_201(self) -> None:
        payload = json.dumps({"name": "Gamma", "owner": "carol", "manufacturedOn": "2024-01-15"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 201

    def test_create_widget_with_an_invalid_scheduled_for_datetime_is_422(self) -> None:
        payload = json.dumps({"name": "Gamma", "owner": "carol", "scheduledFor": "not-a-datetime"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 422

    # A "Z" UTC designator (RFC 3339's preferred form) needs its own normalization -
    # datetime.fromisoformat() only started accepting a bare "Z" in Python 3.11 (see runtime.py's
    # _normalize_z_suffix).
    def test_create_widget_with_a_valid_scheduled_for_datetime_using_z_suffix_returns_201(self) -> None:
        payload = json.dumps({"name": "Gamma", "owner": "carol", "scheduledFor": "2024-01-15T10:30:00Z"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 201

    def test_create_widget_body_violates_min_length_is_422(self) -> None:
        payload = json.dumps({"name": "", "owner": "carol"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 422

    def test_create_widget_missing_required_field_is_422(self) -> None:
        payload = json.dumps({"name": "Gamma"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 422

    def test_get_widget_by_id_returns_widget(self) -> None:
        response = self.fetch("/widgets/1")
        assert response.code == 200
        assert json.loads(response.body)["name"] == "Alpha"

    def test_get_widget_by_id_not_found_is_404(self) -> None:
        response = self.fetch("/widgets/999")
        assert response.code == 404

    def test_delete_widget_requires_bearer_token(self) -> None:
        response = self.fetch("/widgets/1", method="DELETE")
        assert response.code == 401

    def test_delete_widget_with_bearer_token_succeeds(self) -> None:
        response = self.fetch("/widgets/1", method="DELETE", headers={"Authorization": "Bearer sometoken"})
        assert response.code == 204
        assert 1 not in self.handler_impl.widgets

    # Wired from the spec's `security: [{oauth2Auth: [...]}, {apiKeyAuth: []}]` on this operation -
    # an OR-alternative requirement where oauth2Auth is treated identically to a plain bearer token
    # (RFC 6750), and the generated _auth_matched chain picks whichever alternative is satisfied.
    def test_favorite_widget_succeeds_with_only_a_bearer_token(self) -> None:
        response = self.fetch("/widgets/1/favorite", method="POST", body=b"", headers={"Authorization": "Bearer oauth2-token"})
        assert response.code == 204

    def test_favorite_widget_succeeds_with_only_an_api_key(self) -> None:
        response = self.fetch("/widgets/1/favorite", method="POST", body=b"", headers={"X-Api-Key": "my-api-key"})
        assert response.code == 204

    def test_favorite_widget_fails_when_neither_alternative_is_satisfied(self) -> None:
        response = self.fetch("/widgets/1/favorite", method="POST", body=b"")
        assert response.code == 401

    # Wired from `security: [{oauth2Auth: [...], apiKeyAuth: []}, {bearerAuth: []}]` - an
    # AND-within-OR requirement: either (oauth2Auth AND apiKeyAuth together) OR bearerAuth alone.
    def test_archive_widget_succeeds_with_bearer_alone(self) -> None:
        response = self.fetch("/widgets/1/archive", method="POST", body=b"", headers={"Authorization": "Bearer secret-token"})
        assert response.code == 204

    def test_archive_widget_succeeds_with_oauth2_and_api_key_together(self) -> None:
        response = self.fetch(
            "/widgets/1/archive",
            method="POST",
            body=b"",
            headers={"Authorization": "Bearer oauth2-token", "X-Api-Key": "my-api-key"},
        )
        assert response.code == 204

    def test_archive_widget_fails_with_only_an_api_key(self) -> None:
        response = self.fetch("/widgets/1/archive", method="POST", body=b"", headers={"X-Api-Key": "my-api-key"})
        assert response.code == 401

    # `photo` is a real uploaded file part (with filename=), routed through self.request.files -
    # not a plain form field - see operations.js's buildRequestBody isFile branch.
    def test_upload_widget_photo_multipart(self) -> None:
        content_type, body = _multipart_body({"caption": "Nice widget"}, files={"photo": b"binarydata"})
        response = self.fetch("/widgets/1/photo", method="POST", body=body, headers={"Content-Type": content_type})
        assert response.code == 204
        assert self.handler_impl.uploaded_photos[1].caption == "Nice widget"
        assert self.handler_impl.uploaded_photos[1].photo == b"binarydata"

    def test_upload_widget_photo_missing_required_field_is_422(self) -> None:
        content_type, body = _multipart_body({"caption": "Nice widget"})
        response = self.fetch("/widgets/1/photo", method="POST", body=body, headers={"Content-Type": content_type})
        assert response.code == 422

    def test_subscribe_to_widget_urlencoded(self) -> None:
        body = urlencode({"email": "a@example.com", "notify": "true"}).encode("utf-8")
        response = self.fetch(
            "/widgets/1/subscribe", method="POST", body=body, headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        assert response.code == 204
        assert self.handler_impl.subscriptions[1].email == "a@example.com"
        assert self.handler_impl.subscriptions[1].notify is True

    # An array-typed urlencoded field (channels) sends one repeated key per element - read back via
    # self.get_body_arguments (plural), not self.get_body_argument - see operations.js's
    # buildRequestBody.
    def test_subscribe_to_widget_serializes_an_array_typed_urlencoded_field_as_repeated_keys(self) -> None:
        body = urlencode([("email", "a@example.com"), ("channels", "sms"), ("channels", "email")]).encode("utf-8")
        response = self.fetch(
            "/widgets/1/subscribe", method="POST", body=body, headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        assert response.code == 204
        assert self.handler_impl.subscriptions[1].channels == ["sms", "email"]

    def test_get_shape_by_id_returns_discriminated_union(self) -> None:
        response = self.fetch("/widgets/shapes/s1")
        assert response.code == 200
        body = json.loads(response.body)
        assert body == {"shapeType": "circle", "radius": 2.5}

    def test_reset_widgets_returns_empty_body(self) -> None:
        response = self.fetch("/widgets/reset", method="POST", body=b"")
        assert response.code == 200
        assert response.body == b""
        assert len(self.handler_impl.widgets) == 0

    def test_export_widgets_requires_api_key(self) -> None:
        response = self.fetch("/widgets/export")
        assert response.code == 401

    def test_export_widgets_with_api_key_returns_binary(self) -> None:
        response = self.fetch("/widgets/export", headers={"X-Api-Key": "secret"})
        assert response.code == 200
        assert response.headers["Content-Type"] == "application/octet-stream"
        assert response.body == b"WIDGET-ARCHIVE"

    def test_health_check_returns_text_plain(self) -> None:
        response = self.fetch("/health")
        assert response.code == 200
        assert response.headers["Content-Type"] == "text/plain"
        assert response.body == b"OK"


def test_model_validate_rejects_wrong_type() -> None:
    widget = Widget(id="not-an-int", name="X", owner="y", note=None, labels={})  # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        widget.validate()


def test_model_from_wire_and_to_wire_round_trip() -> None:
    wire = {"id": 5, "name": "Delta", "owner": "dave", "note": None, "labels": {"a": "b"}, "status": None, "variant": None}
    widget = Widget.from_wire(wire)
    assert widget is not None
    widget.validate()
    assert Widget.to_wire(widget) == wire


def test_error_response_model_round_trip() -> None:
    err = ErrorResponse.from_wire({"error": "boom"})
    assert err is not None
    err.validate()
    assert ErrorResponse.to_wire(err) == {"error": "boom"}


def test_widget_status_enum_round_trip() -> None:
    assert WidgetStatus.from_wire("available") == WidgetStatus.AVAILABLE
    assert WidgetStatus.to_wire(WidgetStatus.AVAILABLE) == "available"
    assert WidgetStatus.from_wire(None) is None


def test_widget_status_enum_rejects_unknown_value() -> None:
    with pytest.raises(ValidationError):
        WidgetStatus.from_wire("not-a-status")


def test_shape_discriminated_union_round_trip() -> None:
    shape = Shape.from_wire({"shapeType": "square", "side": 4.0})
    assert isinstance(shape, Square)
    assert shape.side == 4.0
    assert Shape.to_wire(shape) == {"shapeType": "square", "side": 4.0}


def test_shape_discriminated_union_rejects_unknown_discriminator() -> None:
    with pytest.raises(ValidationError):
        Shape.from_wire({"shapeType": "triangle"})


def test_widget_variant_undiscriminated_union_round_trip() -> None:
    a = WidgetVariant.from_wire({"kind": "x", "value": 1})
    assert isinstance(a, WidgetVariantA)
    assert WidgetVariant.to_wire(a) == {"kind": "x", "value": 1}

    b = WidgetVariant.from_wire({"label": "hello"})
    assert isinstance(b, WidgetVariantB)

    s = WidgetVariant.from_wire("just a string")
    assert s == "just a string"
    assert WidgetVariant.to_wire(s) == "just a string"


def test_widget_variant_undiscriminated_union_rejects_unrecognized_shape() -> None:
    with pytest.raises(ValidationError):
        WidgetVariant.from_wire(123)


def test_missing_authentication_error_is_distinct_from_validation_error() -> None:
    assert not issubclass(MissingAuthenticationError, ValidationError)
    assert not issubclass(ValidationError, MissingAuthenticationError)


# `default` support: from_wire applies a numeric/enum default when the JSON key is absent, but NOT
# for an explicit JSON null - the same "absent vs. explicit null" distinction the Go/Kotlin
# generators' own default handling preserves (see types.js's buildDefaultLiteral).
def test_new_widget_applies_its_defaults_when_constructed_directly() -> None:
    widget = NewWidget(name="Gamma", owner="carol")
    assert widget.priority == 1
    assert widget.visibility == NewWidgetVisibility.PUBLIC


def test_new_widget_applies_its_defaults_when_the_keys_are_absent_from_wire() -> None:
    widget = NewWidget.from_wire({"name": "Gamma", "owner": "carol"})
    assert widget is not None
    assert widget.priority == 1
    assert widget.visibility == NewWidgetVisibility.PUBLIC


def test_new_widget_does_not_apply_its_default_when_the_key_is_explicitly_null() -> None:
    widget = NewWidget.from_wire({"name": "Gamma", "owner": "carol", "priority": None, "visibility": None})
    assert widget is not None
    assert widget.priority is None
    assert widget.visibility is None
