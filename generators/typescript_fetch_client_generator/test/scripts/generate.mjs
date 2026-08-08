#!/usr/bin/env node
// Regenerates the TypeScript client from resources/kitchensink.yaml via the openapi-yagen CLI,
// twice - see the two execFileSync calls below for why. OPENAPI_YAGEN points at a prebuilt binary,
// falling back to this checkout's own dist/openapi-yagen (mirrors
// generators/kotlin_ktor_client_generator/test/build.gradle.kts's same convention) - make sure
// that's up to date (./build-musl.sh or a local cmake --build) before relying on the fallback, or
// just set OPENAPI_YAGEN explicitly.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = process.env.OPENAPI_YAGEN || path.join(__dirname, "..", "..", "..", "..", "dist", "openapi-yagen");

if (!existsSync(bin)) {
  console.error(
    `openapi-yagen binary not found/executable at ${bin} - build one first (e.g. ./build-musl.sh ` +
      `or cmake --build from the repo root) or set OPENAPI_YAGEN=/path/to/binary`
  );
  process.exit(1);
}

const generatorSrc = path.join(__dirname, "..", "..", "src");
const spec = path.join(__dirname, "..", "resources", "kitchensink.yaml");

// 1. Default (importExtension="") - typechecked only (tsc --noEmit via tsconfig.default.json),
//    proving the common bundler-consumer configuration compiles. Not executed: Node's own ESM
//    loader (used below for the runtime tests) requires explicit extensions, so it can't resolve
//    these imports - a bundler's dev server does that resolution instead, out of scope for a
//    dependency-free test harness to simulate.
execFileSync(
  bin,
  ["g", "-o", path.join(__dirname, "..", "generated-default"), "-g", generatorSrc, "-c", spec],
  { stdio: "inherit" }
);

// 2. importExtension=".js" - typechecked AND actually executed via `node --test`, since Node's
//    native ESM resolver requires exactly this.
execFileSync(
  bin,
  ["g", "-o", path.join(__dirname, "..", "generated"), "-g", generatorSrc, "-c", spec, "-v", "importExtension=.js"],
  { stdio: "inherit" }
);
