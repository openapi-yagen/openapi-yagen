import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Shells out to the openapi-yagen binary directly (not through scripts/generate.mjs, which
// regenerates the *happy-path* kitchensink.yaml fixture under default strict=true) to prove an
// unsupported request-body content-type actually fails generation loudly instead of silently
// dropping the body - see resources/unsupported_content_type.yaml and
// lib/operations.js's pickBodyContent/buildRequestBody.

// __dirname here is the COMPILED location (test/dist/src/, one level deeper than the source
// test/src/ this file lives in - tsc's rootDir "." + outDir "dist" mirrors the whole project,
// including resources/ siblings that aren't part of the TS build) - every path below accounts for
// that extra "dist" level, unlike scripts/generate.mjs (which runs from its own source location
// uncompiled) - see that script's own, one-level-shallower equivalents for comparison.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = process.env.OPENAPI_YAGEN || path.join(__dirname, "..", "..", "..", "..", "..", "dist", "openapi-yagen");
const generatorSrc = path.join(__dirname, "..", "..", "..", "src");
const spec = path.join(__dirname, "..", "..", "resources", "unsupported_content_type.yaml");

function generate(outDir: string, extraArgs: string[] = []): string {
  return execFileSync(bin, ["g", "-o", outDir, "-g", generatorSrc, "-c", spec, ...extraArgs], { encoding: "utf8" });
}

test("an unsupported request body content-type aborts generation by default (strict=true)", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ts-unsupported-strict-"));
  try {
    let threw = false;
    try {
      generate(outDir);
    } catch (e: unknown) {
      threw = true;
      const err = e as { message?: string; stdout?: string; stderr?: string };
      assert.match(`${err.message ?? ""}${err.stdout ?? ""}${err.stderr ?? ""}`, /text\/plain/);
    }
    assert.ok(threw, "expected generation to fail in strict mode");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("an unsupported request body content-type is skipped with a warning under strict=false", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ts-unsupported-permissive-"));
  try {
    const output = generate(outDir, ["-v", "strict=false"]);
    assert.match(output, /WARNING/);
    assert.match(output, /text\/plain/);
    assert.equal(existsSync(path.join(outDir, "apis", "NotesClient.ts")), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
