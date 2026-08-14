import {useCallback, useEffect, useRef} from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import type {WorkerRequest, WorkerResponse} from './protocol';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

// Owns the lifecycle of the dedicated Web Worker that runs the wasm engine (yagen.worker.ts) -
// created lazily on first use, torn down on unmount, and recreatable on demand (cancel()) since
// wasm has no cooperative interruption: the only way to actually stop a slow generate() call is to
// terminate its worker and start a fresh one - see docs/playground.mdx and the worker's own
// comments for why generation runs off the main thread at all.
export function useYagenWorker() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<number, Pending>>(new Map());
  const nextIdRef = useRef(0);
  const wasmJsUrl = useBaseUrl('/wasm/openapi-yagen.js');
  const workerScriptUrl = useBaseUrl('/wasm/yagen.worker.js');

  const teardown = useCallback((reason: string) => {
    const worker = workerRef.current;
    if (worker) {
      worker.terminate();
      workerRef.current = null;
    }
    for (const pending of pendingRef.current.values()) pending.reject(new Error(reason));
    pendingRef.current.clear();
  }, []);

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;

    // A plain URL to a prebuilt static asset (see prepare-assets.mjs), not webpack's native
    // `new Worker(new URL('./yagen.worker.ts', import.meta.url))` support - that broke in
    // production (see prepare-assets.mjs's comment for the "__webpack_require__ is not defined"
    // failure this sidesteps).
    const worker = new Worker(workerScriptUrl, {type: 'module'});
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;
      const pending = pendingRef.current.get(data.id);
      if (!pending) return;
      pendingRef.current.delete(data.id);
      // Cast instead of relying on `if (data.ok)` to narrow: this project's tsconfig (extending
      // @docusaurus/tsconfig) doesn't set strictNullChecks, and TS's control-flow narrowing of a
      // boolean-literal-discriminated union is unreliable without it (reproduced in isolation -
      // narrowing this exact shape works fine with strictNullChecks on, breaks silently without
      // it). Extract<> keeps this checked against WorkerResponse's real shape even so.
      if (data.ok) pending.resolve((data as Extract<WorkerResponse, {ok: true}>).result);
      else pending.reject(new Error((data as Extract<WorkerResponse, {ok: false}>).error));
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      teardown(event.message || 'Worker crashed');
    };
    workerRef.current = worker;

    const initReq: WorkerRequest = {id: nextIdRef.current++, type: 'init', wasmJsUrl};
    worker.postMessage(initReq);
    // No need to track this request's response here - request() below awaits modulePromise inside
    // the worker regardless of whether 'init' has resolved yet (see yagen.worker.ts), so callers
    // don't have to sequence their first real request after this one completes.
    pendingRef.current.set(initReq.id, {resolve: () => {}, reject: () => {}});

    return worker;
  }, [teardown, wasmJsUrl, workerScriptUrl]);

  const request = useCallback(
    <T,>(req: Omit<WorkerRequest, 'id'>): Promise<T> => {
      const worker = ensureWorker();
      const id = nextIdRef.current++;
      return new Promise<T>((resolve, reject) => {
        pendingRef.current.set(id, {resolve: resolve as (v: unknown) => void, reject});
        worker.postMessage({...req, id} as WorkerRequest);
      });
    },
    [ensureWorker],
  );

  // Terminates the current worker (aborting anything in flight) and lets the next request() spin
  // up a fresh one, automatically re-sent 'init' included.
  const cancel = useCallback(() => teardown('Cancelled'), [teardown]);

  useEffect(() => () => teardown('Component unmounted'), [teardown]);

  return {request, cancel};
}
