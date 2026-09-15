import { test } from "node:test";
import assert from "node:assert/strict";
import { PetsClient } from "../generated/apis/PetsClient.js";
import { createFetchStub } from "./support/fetchStub.js";

test("an empty baseUrl (same-origin) builds a relative URL", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 200, body: { id: 1, name: "Rex" } }));
  await new PetsClient({ baseUrl: "", fetch }).getPetById("1");
  assert.equal(calls[0]!.url, "/pets/1");
});

test("a relative baseUrl builds a relative URL under it", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 200, body: { id: 1, name: "Rex" } }));
  await new PetsClient({ baseUrl: "/api", fetch }).getPetById("1");
  assert.equal(calls[0]!.url, "/api/pets/1");
});

test("an empty baseUrl still appends the query string correctly", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 200, body: [] }));
  await new PetsClient({ baseUrl: "", fetch }).listPets({ tag: "dog" });
  assert.equal(calls[0]!.url, "/pets?tag=dog");
});
