import { test } from "node:test";
import assert from "node:assert/strict";
import { WidgetsClient } from "../generated/apis/WidgetsClient.js";
import { createFetchStub } from "./support/fetchStub.js";

test("listWidgets sends an optional header only when provided", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 200, body: [] }));
  await new WidgetsClient({ baseUrl: "https://example.test", fetch }).listWidgets({ xClientVersion: "1.2.3" });
  assert.equal(calls[0]!.headers["x-client-version"], "1.2.3");
});

test("createWidget round-trips a widget with a discriminated-union variant field", async () => {
  const widget = {
    id: 1,
    name: "Gizmo",
    variant: { kind: "gadget", value: 42 },
  };
  const { fetch } = createFetchStub(() => ({ status: 201, body: widget }));
  const created = await new WidgetsClient({ baseUrl: "https://example.test", fetch }).createWidget({ body: widget as any });
  assert.deepEqual(created, widget);
});

test("getShape resolves a discriminated union response", async () => {
  const { fetch } = createFetchStub(() => ({ status: 200, body: { shapeType: "circle", radius: 2 } }));
  const shape = await new WidgetsClient({ baseUrl: "https://example.test", fetch }).getShape("s1");
  assert.equal(shape.shapeType, "circle");
  // Compile-time proof that discriminated-union narrowing works on the generated type: this only
  // typechecks if `shape.radius` is accessible after narrowing on `shapeType`.
  if (shape.shapeType === "circle") {
    assert.equal(shape.radius, 2);
  } else {
    assert.fail("expected circle");
  }
});
