import {zipSync, strToU8} from 'fflate';
import type {GeneratedFile} from './protocol';

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Zips generated files client-side (via fflate, a small dependency-free zip lib) and triggers a
// browser download - kept out of the wasm bridge on purpose, so it only ever deals in plain
// strings (see wasm/bridge.cpp's comment on GenerateResult).
export function downloadFilesAsZip(files: readonly GeneratedFile[], zipName: string): void {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) entries[file.path] = strToU8(file.content);
  triggerDownload(new Blob([zipSync(entries, {level: 6})], {type: 'application/zip'}), zipName);
}

export function downloadTextFile(text: string, filename: string): void {
  triggerDownload(new Blob([text], {type: 'text/plain'}), filename);
}
