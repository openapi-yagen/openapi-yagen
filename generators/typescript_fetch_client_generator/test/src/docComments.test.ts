import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Asserts that OpenAPI `description` (schema/model, property, parameter, operation) and the
// document's `tags[].description` all reach the generated source as TSDoc comments - not just
// that the generated code compiles/runs (the other test files in this suite), but that this
// generator promise actually holds. Reads the raw *source* .ts file text (not the compiled .js
// this test itself runs as - tsc strips comments), since TSDoc comments aren't part of the
// compiled output at all.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = path.join(__dirname, "..", "..", "generated");

function readGenerated(relPath: string): string {
  return readFileSync(path.join(generatedDir, relPath), "utf8");
}

// Model/property descriptions render via the multi-line-safe "/**\n * ...\n */" block form (see
// docs/templating.md's indent()) - even for a single-sentence description - rather than a
// single-line "/** ... */", so a description containing an embedded newline still produces valid
// TSDoc. model_type_alias.ts.j2 has no nested/multi-line content to protect against, so it keeps
// the single-line form (untested here).
test("model and property descriptions land as TSDoc", () => {
  const pet = readGenerated("models/Pet.ts");
  assert.match(pet, /\* A pet available in the store\./, `missing model-level TSDoc:\n${pet}`);
  assert.match(pet, /\* The pet's display name\./, `missing property-level TSDoc:\n${pet}`);
});

test("operation summary, description, and param docs land as TSDoc, and the class itself gets the tag's description", () => {
  const petsClient = readGenerated("apis/PetsClient.ts");
  assert.match(
    petsClient,
    /\* Operations for browsing and managing pets/,
    `missing class-level (tag) TSDoc:\n${petsClient}`
  );
  assert.match(petsClient, /\* List all pets\./, `missing operation summary:\n${petsClient}`);
  assert.match(
    petsClient,
    /\* Returns a page of pets, optionally filtered by tag\./,
    `missing operation description:\n${petsClient}`
  );
  assert.match(petsClient, /\* @param limit Maximum number of pets to return\./, `missing @param limit:\n${petsClient}`);
});

test("ApiClient bundle class gets the document's top-level info description", () => {
  const index = readGenerated("index.ts");
  assert.match(
    index,
    /\* A small, purpose-built spec exercising every feature this generator's README claims to support/,
    `missing top-level (info.description) TSDoc on the bundle class:\n${index}`
  );
});

test("each ApiClient property gets the same tag description as the class it points to", () => {
  const index = readGenerated("index.ts");
  assert.match(
    index,
    /\* Operations for browsing and managing pets/,
    `missing property-level (tag) TSDoc on ApiClient.pets:\n${index}`
  );
});

test("an operation with no summary or description gets no doc comment, not an empty one", () => {
  const petsClient = readGenerated("apis/PetsClient.ts");
  const lines = petsClient.split("\n");
  const fnIndex = lines.findIndex((l) => l.includes("createPet("));
  assert.ok(fnIndex > 0, "createPet method not found");
  const precedingLine = [...lines.slice(0, fnIndex)].reverse().find((l) => l.trim() !== "")!;
  assert.ok(
    !precedingLine.trimStart().startsWith("*") && !precedingLine.trimStart().startsWith("/**"),
    `unexpected doc comment before createPet: "${precedingLine}"`
  );
});
