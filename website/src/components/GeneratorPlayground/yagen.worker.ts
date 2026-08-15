// Runs the openapi-yagen wasm module - the Emscripten build of the same C++ engine the CLI uses
// (see wasm/bridge.cpp), single-threaded and worker-only (no -pthread: see wasm/CMakeLists.txt for
// why). Generation is a synchronous, potentially slow wasm call; doing it here instead of the main
// thread is what keeps the page responsive - see docs/playground.mdx.
//
// This file itself is bundled by esbuild into a standalone static asset (see prepare-assets.mjs -
// not webpack's native `new Worker(new URL(...))` support, which broke in production; see that
// script's comment for why). The wasm glue JS (openapi-yagen.js/.wasm) is a separate prebuilt
// Emscripten artifact staged the same way, loaded here via a runtime import() of an absolute URL
// the main thread computes with useBaseUrl() and sends in the 'init' message.
//
// No `/// <reference lib="webworker" />`: this file is compiled together with the rest of the
// (DOM-lib) website in a single tsc program (see tsconfig.json - no per-file lib overrides), and
// webworker lib's ambient globals (MessageEvent, self, ...) redeclare DOM lib's incompatibly,
// which silently breaks discriminated-union narrowing on MessageEvent.data project-wide instead of
// erroring - `self` is typed narrowly below instead, to just what this file actually uses.

import type {GeneratedFile, GeneratorSource, LogEntry, VariableInfo, WorkerRequest, WorkerResponse} from './protocol';

declare const self: {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

// Minimal shape of what wasm/bridge.cpp's EMSCRIPTEN_BINDINGS exposes - see that file. Embind
// vectors (register_vector<T>) come back as live handles wrapping wasm-heap memory, not plain JS
// arrays - see vecToArray below for why every one of these gets explicitly .delete()d.
interface EmbindVector<T> {
  size(): number;
  get(i: number): T;
  push_back(v: T): void;
  delete(): void;
}

interface RawGeneratorInfoResult {
  ok: boolean;
  error: string;
  name: string;
  description: string;
  openApiVersion: string;
  variables: EmbindVector<VariableInfo>;
}

interface RawGenerateResult {
  ok: boolean;
  error: string;
  files: EmbindVector<GeneratedFile>;
  logs: EmbindVector<LogEntry>;
}

interface RawConvertResult {
  ok: boolean;
  error: string;
  text: string;
  logs: EmbindVector<LogEntry>;
}

interface RawBuiltinGeneratorSummary {
  name: string;
  description: string;
  openApiVersion: string;
}

interface YagenModule {
  listBuiltinGenerators(): EmbindVector<RawBuiltinGeneratorSummary>;
  getBuiltinGeneratorInfo(name: string): RawGeneratorInfoResult;
  getZipGeneratorInfo(bytes: Uint8Array): RawGeneratorInfoResult;
  generateFromBuiltin(spec: string, name: string, vars: EmbindVector<string>, tags: EmbindVector<string>): RawGenerateResult;
  generateFromZip(spec: string, bytes: Uint8Array, vars: EmbindVector<string>, tags: EmbindVector<string>): RawGenerateResult;
  convertSpec(spec: string, fromVersion: string, toVersion: string, format: string): RawConvertResult;
  setLogLevel(level: string): boolean;
  StringVector: new () => EmbindVector<string>;
}

let modulePromise: Promise<YagenModule> | null = null;

function loadModule(wasmJsUrl: string): Promise<YagenModule> {
  if (!modulePromise) {
    modulePromise = import(wasmJsUrl).then((glue: {default: () => Promise<YagenModule>}) =>
      glue.default(),
    );
  }
  return modulePromise;
}

// Reads an Embind vector into a plain array, then frees the wasm-side handle - these don't get
// garbage collected on their own, unlike the value_object structs (GenerateResult, ...) they're
// nested in, which Embind already converts to plain JS objects for us.
function vecToArray<T, R>(vec: EmbindVector<T>, map: (v: T) => R): R[] {
  const out: R[] = [];
  const n = vec.size();
  for (let i = 0; i < n; i++) out.push(map(vec.get(i)));
  vec.delete();
  return out;
}

function toStringVector(Module: YagenModule, values: readonly string[]): EmbindVector<string> {
  const vec = new Module.StringVector();
  for (const v of values) vec.push_back(v);
  return vec;
}

function withStringVector<T>(Module: YagenModule, values: readonly string[], fn: (vec: EmbindVector<string>) => T): T {
  const vec = toStringVector(Module, values);
  try {
    return fn(vec);
  } finally {
    vec.delete();
  }
}

function getGeneratorInfo(Module: YagenModule, source: GeneratorSource): RawGeneratorInfoResult {
  return source.kind === 'builtin' ? Module.getBuiltinGeneratorInfo(source.name) : Module.getZipGeneratorInfo(source.bytes);
}

function generate(
  Module: YagenModule,
  spec: string,
  source: GeneratorSource,
  vars: readonly string[],
  tags: readonly string[],
): RawGenerateResult {
  return withStringVector(Module, vars, (varsVec) =>
    withStringVector(Module, tags, (tagsVec) =>
      source.kind === 'builtin'
        ? Module.generateFromBuiltin(spec, source.name, varsVec, tagsVec)
        : Module.generateFromZip(spec, source.bytes, varsVec, tagsVec),
    ),
  );
}

async function handleRequest(req: WorkerRequest): Promise<unknown> {
  if (req.type === 'init') {
    await loadModule(req.wasmJsUrl);
    return undefined;
  }

  // Every other request implies the module was already warmed up by 'init' - awaiting the same
  // promise here is a no-op once resolved, and correct (not a race) if a request somehow arrives
  // before 'init' finished.
  if (!modulePromise) throw new Error('Worker used before init');
  const Module = await modulePromise;

  switch (req.type) {
    case 'listBuiltinGenerators':
      return vecToArray(Module.listBuiltinGenerators(), (g) => ({...g}));

    case 'getGeneratorInfo': {
      const raw = getGeneratorInfo(Module, req.source);
      const variables = vecToArray(raw.variables, (v) => ({...v}));
      return {ok: raw.ok, error: raw.error, name: raw.name, description: raw.description, openApiVersion: raw.openApiVersion, variables};
    }

    case 'generate': {
      Module.setLogLevel(req.logLevel);
      const raw = generate(Module, req.spec, req.source, req.vars, req.tags);
      const files = vecToArray(raw.files, (f) => ({...f}));
      const logs = vecToArray(raw.logs, (l) => ({...l}));
      return {ok: raw.ok, error: raw.error, files, logs};
    }

    case 'convert': {
      Module.setLogLevel(req.logLevel);
      const raw = Module.convertSpec(req.spec, req.fromVersion, req.toVersion, req.format);
      const logs = vecToArray(raw.logs, (l) => ({...l}));
      return {ok: raw.ok, error: raw.error, text: raw.text, logs};
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  handleRequest(req)
    .then((result) => {
      const response: WorkerResponse = {id: req.id, ok: true, result};
      self.postMessage(response);
    })
    .catch((e: unknown) => {
      const response: WorkerResponse = {id: req.id, ok: false, error: e instanceof Error ? e.message : String(e)};
      self.postMessage(response);
    });
};
