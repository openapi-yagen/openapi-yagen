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

// Wired from the spec's `security: [{oauth2Auth: [...]}, {apiKeyAuth: []}]` on this operation (see
// components.securitySchemes.oauth2Auth in kitchensink.yaml) - an OR-alternative requirement where
// oauth2Auth is treated identically to a plain bearer token (RFC 6750), and applyAuth (runtime.ts)
// picks whichever alternative is fully configured.
test("favoriteWidget uses the bearer alternative when only a bearer token is configured", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await new WidgetsClient({ baseUrl: "https://example.test", fetch, auth: { bearer: () => "oauth2-token" } }).favoriteWidget("1");
  assert.equal(calls[0]!.headers["authorization"], "Bearer oauth2-token");
});

test("favoriteWidget uses the apiKey alternative when only an apiKey is configured", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await new WidgetsClient({ baseUrl: "https://example.test", fetch, auth: { apiKey: () => "my-api-key" } }).favoriteWidget("1");
  assert.equal(calls[0]!.headers["x-api-key"], "my-api-key");
  assert.equal(calls[0]!.headers["authorization"], undefined);
});

test("favoriteWidget throws when neither alternative's credential is configured", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await assert.rejects(
    () => new WidgetsClient({ baseUrl: "https://example.test", fetch }).favoriteWidget("1"),
    /requires ApiClientConfig\.auth\.bearer, or ApiClientConfig\.auth\.apiKey/
  );
  assert.equal(calls.length, 0);
});

// Wired from the spec's `security: [{oauth2Auth: [...], apiKeyAuth: []}, {bearerAuth: []}]` - an
// AND-within-OR requirement: either (oauth2Auth AND apiKeyAuth together) OR bearerAuth alone.
test("archiveWidget uses the bearerAuth-alone alternative when only a bearer token is configured", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await new WidgetsClient({ baseUrl: "https://example.test", fetch, auth: { bearer: () => "secret-token" } }).archiveWidget("1");
  assert.equal(calls[0]!.headers["authorization"], "Bearer secret-token");
  assert.equal(calls[0]!.headers["x-api-key"], undefined);
});

// AuthProvider has a single `bearer` slot shared by both oauth2Auth and bearerAuth (there's no way
// to tell them apart at the config level - both are RFC 6750 bearer tokens), so when both `bearer`
// and `apiKey` are configured, the first fully-satisfied alternative wins: the combined
// oauth2Auth+apiKeyAuth one (declared first in the spec), not the bearerAuth-alone one.
test("archiveWidget picks the first fully-satisfied alternative (combined oauth2+apiKey) when both credentials are configured", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await new WidgetsClient({
    baseUrl: "https://example.test",
    fetch,
    auth: { bearer: () => "oauth2-token", apiKey: () => "my-api-key" },
  }).archiveWidget("1");
  assert.equal(calls[0]!.headers["authorization"], "Bearer oauth2-token");
  assert.equal(calls[0]!.headers["x-api-key"], "my-api-key");
});

test("archiveWidget throws when only an apiKey is configured (satisfies neither alternative alone)", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await assert.rejects(() => new WidgetsClient({ baseUrl: "https://example.test", fetch, auth: { apiKey: () => "my-api-key" } }).archiveWidget("1"));
  assert.equal(calls.length, 0);
});
