import {copyFile, mkdir} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {access} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as esbuild from 'esbuild';

const websiteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(websiteDir, '..');
const sourceLogo = resolve(repoRoot, 'openapi-yagen.png');
const imageDir = resolve(websiteDir, '.generated-static', 'img');

await mkdir(imageDir, {recursive: true});
await copyFile(sourceLogo, resolve(imageDir, 'openapi-yagen.png'));
await copyFile(sourceLogo, resolve(imageDir, 'openapi-yagen-social.png'));

// The playground page's wasm module - built separately via build-wasm.sh (see Dockerfile.wasm,
// wired into CI in .github/workflows/docs.yml) since it requires the Emscripten SDK, not anything
// npm can produce. Staged here the same way the logo above is, into staticDirectories. Skipped
// with a warning (not a hard failure) when dist/wasm doesn't exist, so `npm start`/`npm run build`
// still work for docs-only edits without requiring a local wasm build first - the playground page
// itself only needs the files present when actually exercising it.
const wasmSourceDir = resolve(repoRoot, 'dist', 'wasm');
const wasmDestDir = resolve(websiteDir, '.generated-static', 'wasm');
const wasmFiles = ['openapi-yagen.js', 'openapi-yagen.wasm'];

const wasmSourceExists = await access(wasmSourceDir, fsConstants.F_OK).then(
  () => true,
  () => false,
);

if (wasmSourceExists) {
  await mkdir(wasmDestDir, {recursive: true});
  await Promise.all(
    wasmFiles.map((f) => copyFile(resolve(wasmSourceDir, f), resolve(wasmDestDir, f))),
  );
} else {
  console.warn(
    `[prepare-assets] ${wasmSourceDir} not found - skipping playground wasm assets ` +
      `(run ./build-wasm.sh first to build them; see docs/playground.mdx).`,
  );
}

// yagen.worker.ts is bundled here with esbuild into a standalone static asset, deliberately NOT
// left to webpack's native `new Worker(new URL(...))` support: in Docusaurus's production build
// (custom non-root baseUrl, code-split chunks), the webpack-bundled worker chunk failed at load
// time with "Uncaught ReferenceError: __webpack_require__ is not defined" - reproduced with a real
// browser against a `docusaurus build` + `docusaurus serve` output (worked fine under
// `docusaurus start`'s dev server, which doesn't reproduce production chunking/publicPath
// behavior). Bundling it as a fully self-contained ESM file up front, served as a static asset the
// same way openapi-yagen.js/.wasm already are, sidesteps that whole class of bug: the worker never
// touches webpack's runtime at all. Always rebuilt (cheap, no wasm SDK involved), unlike the wasm
// module above.
const workerEntry = resolve(websiteDir, 'src', 'components', 'GeneratorPlayground', 'yagen.worker.ts');
await mkdir(wasmDestDir, {recursive: true});
await esbuild.build({
  entryPoints: [workerEntry],
  outfile: resolve(wasmDestDir, 'yagen.worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
});
