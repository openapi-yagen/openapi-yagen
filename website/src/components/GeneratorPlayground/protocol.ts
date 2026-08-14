// Message protocol shared between the GeneratorPlayground component (main thread) and
// yagen.worker.ts (the dedicated Web Worker that owns the wasm module - see that file for why).
// Every request carries a numeric `id` so responses (which can arrive after later requests, e.g.
// a slow generate() overlapping a cancel-and-restart) can be correlated; in practice the UI only
// ever has one request in flight at a time.

export type GeneratorSource = {kind: 'builtin'; name: string} | {kind: 'zip'; bytes: Uint8Array};

export interface VariableInfo {
  name: string;
  description: string;
  defaultValue: string;
  required: boolean;
}

export interface GeneratorInfo {
  ok: boolean;
  error: string;
  name: string;
  description: string;
  openApiVersion: string;
  variables: VariableInfo[];
}

export interface BuiltinGeneratorSummary {
  name: string;
  description: string;
  openApiVersion: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

// Mirrors LogFacade::LogLevel (lib/logger/logger.h) - the levels the C++ engine's logger accepts.
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: string;
  name: string;
  message: string;
}

export interface GenerateResult {
  ok: boolean;
  error: string;
  files: GeneratedFile[];
  logs: LogEntry[];
}

export interface ConvertResult {
  ok: boolean;
  error: string;
  text: string;
  logs: LogEntry[];
}

export type WorkerRequest =
  | {id: number; type: 'init'; wasmJsUrl: string}
  | {id: number; type: 'listBuiltinGenerators'}
  | {id: number; type: 'getGeneratorInfo'; source: GeneratorSource}
  | {id: number; type: 'generate'; spec: string; source: GeneratorSource; vars: string[]; logLevel: LogLevel}
  | {
      id: number;
      type: 'convert';
      spec: string;
      fromVersion: string;
      toVersion: string;
      format: 'yaml' | 'json';
      logLevel: LogLevel;
    };

export type WorkerResponse =
  | {id: number; ok: true; result: unknown}
  | {id: number; ok: false; error: string};
