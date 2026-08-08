import { test } from "node:test";
import assert from "node:assert/strict";
import { PetsClient } from "../generated/apis/PetsClient.js";
import type { WidgetVariant } from "../generated/models/WidgetVariant.js";
import { createFetchStub } from "./support/fetchStub.js";

test("getNamedTag resolves an allOf-flattened model (Tag properties + species)", async () => {
  const { fetch } = createFetchStub(() => ({ status: 200, body: { id: 7, name: "fluffy", species: "cat" } }));
  const namedPet = await new PetsClient({ baseUrl: "https://example.test", fetch }).getNamedTag("1");
  assert.equal(namedPet.id, 7);
  assert.equal(namedPet.name, "fluffy");
  assert.equal(namedPet.species, "cat");
});

test("an undiscriminated union value narrows on its own shape at the call site", () => {
  function describe(variant: WidgetVariant): string {
    if (typeof variant === "string") return `bare:${variant}`;
    if ("kind" in variant) return `a:${variant.kind}:${variant.value}`;
    return `b:${variant.label}`;
  }
  assert.equal(describe("plain"), "bare:plain");
  assert.equal(describe({ kind: "x", value: 1 }), "a:x:1");
  assert.equal(describe({ label: "y" }), "b:y");
});
