// Exercises the opt-in `-v validateResponses=true` mode (see generator.yml) against a separate
// generated-validated/ output tree (see scripts/generate.mjs) - kept apart from
// test/src/*.test.ts, which exercise the default (validateResponses off) tree and must keep
// passing unmodified regardless of this file, proving the two modes don't interfere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PetsClient } from "../../generated-validated/apis/PetsClient.js";
import { WidgetsClient } from "../../generated-validated/apis/WidgetsClient.js";
import { ResponseValidationError } from "../../generated-validated/runtime.js";
import { isPet } from "../../generated-validated/models/Pet.js";
import { createFetchStub } from "../support/fetchStub.js";

test("a well-formed response still resolves normally", async () => {
  const { fetch } = createFetchStub(() => ({ status: 200, body: { id: 1, name: "Rex", status: "available" } }));
  const pet = await new PetsClient({ baseUrl: "https://example.test", fetch }).getPetById("1");
  assert.equal(pet.name, "Rex");
});

test("a response missing a required property throws ResponseValidationError", async () => {
  const { fetch } = createFetchStub(() => ({ status: 200, body: { name: "Rex" } })); // missing required "id"
  await assert.rejects(
    () => new PetsClient({ baseUrl: "https://example.test", fetch }).getPetById("1"),
    (err: unknown) => {
      assert.ok(err instanceof ResponseValidationError);
      assert.deepEqual(err.value, { name: "Rex" });
      return true;
    }
  );
});

test("a response with a wrong property type throws ResponseValidationError", async () => {
  const { fetch } = createFetchStub(() => ({ status: 200, body: { id: "not-a-number", name: "Rex" } }));
  await assert.rejects(() => new PetsClient({ baseUrl: "https://example.test", fetch }).getPetById("1"), ResponseValidationError);
});

test("a malformed array-response item throws ResponseValidationError", async () => {
  const { fetch } = createFetchStub(() => ({ status: 200, body: [{ id: 1, name: "Rex" }, { id: "bad", name: 2 }] }));
  await assert.rejects(() => new PetsClient({ baseUrl: "https://example.test", fetch }).listPets(), ResponseValidationError);
});

test("a discriminated-union response that matches no variant throws ResponseValidationError", async () => {
  const { fetch } = createFetchStub(() => ({ status: 200, body: { shapeType: "triangle", sides: 3 } }));
  await assert.rejects(() => new WidgetsClient({ baseUrl: "https://example.test", fetch }).getShape("s1"), ResponseValidationError);
});

test("an allOf-flattened response missing the merged-in property throws ResponseValidationError", async () => {
  const { fetch } = createFetchStub(() => ({ status: 200, body: { id: 7, name: "fluffy" } })); // missing "species"
  await assert.rejects(() => new PetsClient({ baseUrl: "https://example.test", fetch }).getNamedTag("1"), ResponseValidationError);
});

test("exported guard functions are directly usable outside the client (e.g. narrowing unknown data)", () => {
  const value: unknown = { id: 1, name: "Rex" };
  assert.ok(isPet(value));
  assert.equal(isPet({ id: "nope" }), false);
});
