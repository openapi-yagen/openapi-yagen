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
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from tornado.testing import AsyncHTTPTestCase

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
from kitchensink_api.models import ErrorResponse, NewWidget, Widget  # noqa: E402
from kitchensink_api.runtime import ValidationError  # noqa: E402


class FakeWidgetsHandler(WidgetsHandler):
    def __init__(self) -> None:
        self.widgets: Dict[int, Widget] = {
            1: Widget(id=1, name="Alpha", owner="alice", note=None, labels={"color": "red"}),
            2: Widget(id=2, name="Beta", owner="bob", note="fragile", labels={}),
        }
        self._next_id = 3

    def list_widgets(self, *, owner: Optional[str]) -> List[Widget]:
        if owner is None:
            return list(self.widgets.values())
        return [w for w in self.widgets.values() if w.owner == owner]

    def create_widget(self, *, x_request_id: str, body: NewWidget) -> Widget:
        widget = Widget(id=self._next_id, name=body.name, owner=body.owner, note=body.note, labels=body.labels)
        self.widgets[self._next_id] = widget
        self._next_id += 1
        return widget

    def reset_widgets(self) -> None:
        self.widgets.clear()

    def export_widgets(self) -> bytes:
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

    def test_create_widget_success(self) -> None:
        payload = json.dumps({"name": "Gamma", "owner": "carol", "labels": {}}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 201
        body = json.loads(response.body)
        assert body["name"] == "Gamma"
        assert body["owner"] == "carol"
        assert body["note"] is None

    def test_create_widget_missing_required_header_is_422(self) -> None:
        payload = json.dumps({"name": "Gamma", "owner": "carol"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload)
        assert response.code == 422

    def test_create_widget_body_violates_min_length_is_422(self) -> None:
        payload = json.dumps({"name": "", "owner": "carol"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 422

    def test_create_widget_missing_required_field_is_422(self) -> None:
        payload = json.dumps({"name": "Gamma"}).encode("utf-8")
        response = self.fetch("/widgets", method="POST", body=payload, headers={"X-Request-ID": "abc123"})
        assert response.code == 422

    def test_reset_widgets_returns_empty_body(self) -> None:
        response = self.fetch("/widgets/reset", method="POST", body=b"")
        assert response.code == 200
        assert response.body == b""
        assert len(self.handler_impl.widgets) == 0

    def test_export_widgets_returns_binary(self) -> None:
        response = self.fetch("/widgets/export")
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
    wire = {"id": 5, "name": "Delta", "owner": "dave", "note": None, "labels": {"a": "b"}}
    widget = Widget.from_wire(wire)
    assert widget is not None
    widget.validate()
    assert Widget.to_wire(widget) == wire


def test_error_response_model_round_trip() -> None:
    err = ErrorResponse.from_wire({"error": "boom"})
    assert err is not None
    err.validate()
    assert ErrorResponse.to_wire(err) == {"error": "boom"}
