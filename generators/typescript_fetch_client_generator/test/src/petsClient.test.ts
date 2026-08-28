import { test } from "node:test";
import assert from "node:assert/strict";
import { PetsClient } from "../generated/apis/PetsClient.js";
import { ApiError } from "../generated/runtime.js";
import { PetStatus } from "../generated/models/PetStatus.js";
import { createFetchStub } from "./support/fetchStub.js";

test("getPetById sends the correct path and parses the JSON response", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 200, body: { id: 1, name: "Rex", status: "available" } }));
  const pet = await new PetsClient({ baseUrl: "https://example.test", fetch }).getPetById("1");
  assert.equal(calls[0]!.url, "https://example.test/pets/1");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(pet.name, "Rex");
  assert.equal(pet.status, PetStatus.Available);
});

test("getPetById URL-encodes the path parameter", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 200, body: { id: 1, name: "Rex" } }));
  await new PetsClient({ baseUrl: "https://example.test", fetch }).getPetById("a/b");
  assert.equal(calls[0]!.url, "https://example.test/pets/a%2Fb");
});

test("listPets omits undefined optional query params but includes provided ones", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 200, body: [] }));
  await new PetsClient({ baseUrl: "https://example.test", fetch }).listPets({ tag: "dog" });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("tag"), "dog");
  assert.equal(url.searchParams.has("limit"), false);
});

test("listPets serializes an array-typed query parameter as repeated keys", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 200, body: [] }));
  await new PetsClient({ baseUrl: "https://example.test", fetch }).listPets({ tags: ["dog", "small"] });
  const url = new URL(calls[0]!.url);
  assert.deepEqual(url.searchParams.getAll("tags"), ["dog", "small"]);
});

test("createPet sends the body as JSON with a Content-Type header", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 201, body: { id: 1, name: "Rex" } }));
  await new PetsClient({ baseUrl: "https://example.test", fetch }).createPet({ body: { name: "Rex" } });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0]!.body as string), { name: "Rex" });
});

test("ratePet sends a required header", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await new PetsClient({ baseUrl: "https://example.test", fetch, auth: { apiKey: () => "test-key" } }).ratePet("1", {
    xRequestId: "req-42",
    body: { score: 5, label: "great" },
  });
  assert.equal(calls[0]!.headers["x-request-id"], "req-42");
});

// Wired from the spec's `security: [{apiKeyAuth: []}]` on this operation (see
// components.securitySchemes.apiKeyAuth, an apiKey scheme in the X-Api-Key header).
test("ratePet applies the configured apiKey as the scheme's declared header", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await new PetsClient({ baseUrl: "https://example.test", fetch, auth: { apiKey: () => "my-api-key" } }).ratePet("1", {
    xRequestId: "req-42",
    body: { score: 5, label: "great" },
  });
  assert.equal(calls[0]!.headers["x-api-key"], "my-api-key");
});

test("ratePet without an apiKey configured on ApiClientConfig throws before sending a request", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await assert.rejects(
    () =>
      new PetsClient({ baseUrl: "https://example.test", fetch }).ratePet("1", {
        xRequestId: "req-42",
        body: { score: 5, label: "great" },
      }),
    /requires ApiClientConfig\.auth\.apiKey/
  );
  assert.equal(calls.length, 0);
});

test("a non-2xx response throws ApiError with the parsed body and status", async () => {
  const { fetch } = createFetchStub(() => ({
    status: 404,
    statusText: "Not Found",
    body: { code: 404, message: "not found" },
  }));
  await assert.rejects(
    () => new PetsClient({ baseUrl: "https://example.test", fetch }).getPetById("missing"),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 404);
      assert.equal(err.statusText, "Not Found");
      assert.deepEqual(err.body, { code: 404, message: "not found" });
      return true;
    }
  );
});

test("deletePet against a 204 No Content response resolves without error", async () => {
  const { fetch } = createFetchStub(() => ({ status: 204 }));
  await assert.doesNotReject(() =>
    new PetsClient({ baseUrl: "https://example.test", fetch, auth: { bearer: () => "secret-token" } }).deletePet("1")
  );
});

// Wired from the spec's `security: [{bearerAuth: []}]` on this operation (see
// components.securitySchemes.bearerAuth in kitchensink.yaml).
test("deletePet sends the configured bearer token as an Authorization header", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await new PetsClient({ baseUrl: "https://example.test", fetch, auth: { bearer: () => "secret-token" } }).deletePet("1");
  assert.equal(calls[0]!.headers["authorization"], "Bearer secret-token");
});

test("deletePet without a bearer token configured on ApiClientConfig throws before sending a request", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await assert.rejects(
    () => new PetsClient({ baseUrl: "https://example.test", fetch }).deletePet("1"),
    /requires ApiClientConfig\.auth\.bearer/
  );
  assert.equal(calls.length, 0);
});

test("a rotating bearer token (HeaderProvider callback) is re-resolved on every request", async () => {
  let token = "token-1";
  const { fetch, calls } = createFetchStub(() => ({ status: 200, body: { id: 1, name: "Rex" } }));
  const client = new PetsClient({
    baseUrl: "https://example.test",
    fetch,
    headers: async () => ({ Authorization: `Bearer ${token}` }),
  });
  await client.getPetById("1");
  token = "token-2";
  await client.getPetById("1");
  assert.equal(calls[0]!.headers["authorization"], "Bearer token-1");
  assert.equal(calls[1]!.headers["authorization"], "Bearer token-2");
});
