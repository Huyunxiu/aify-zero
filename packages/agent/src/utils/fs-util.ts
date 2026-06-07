import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

import { fileTypeFromBuffer } from "file-type";

export function windowsPath(p: string): string {
  if (process.platform !== "win32") {
    return p;
  }
  return p
    .replace(
      // oxlint-disable-next-line require-unicode-regexp
      /^\/([a-zA-Z]):(?:[\\/]|$)/,
      // oxlint-disable-next-line typescript/no-unsafe-call typescript/no-unsafe-member-access
      (_, drive) => `${drive.toUpperCase()}:/`
    )
    .replace(
      // oxlint-disable-next-line require-unicode-regexp
      /^\/([a-zA-Z])(?:\/|$)/,
      // oxlint-disable-next-line typescript/no-unsafe-call typescript/no-unsafe-member-access
      (_, drive) => `${drive.toUpperCase()}:/`
    )
    .replace(
      // oxlint-disable-next-line require-unicode-regexp
      /^\/cygdrive\/([a-zA-Z])(?:\/|$)/,
      // oxlint-disable-next-line typescript/no-unsafe-call typescript/no-unsafe-member-access
      (_, drive) => `${drive.toUpperCase()}:/`
    )
    .replace(
      // oxlint-disable-next-line require-unicode-regexp
      /^\/mnt\/([a-zA-Z])(?:\/|$)/,
      // oxlint-disable-next-line typescript/no-unsafe-call typescript/no-unsafe-member-access
      (_, drive) => `${drive.toUpperCase()}:/`
    );
}

export function normalizePath(p: string): string {
  if (process.platform !== "win32") {
    return p;
  }
  const resolved = pathResolve(windowsPath(p));
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

const SAMPLE_BYTES = 4096;

export async function getFileTypeFromBuffer(
  filepath: string,
  fileSize: number,
  sampleSize: number = SAMPLE_BYTES
): Promise<[string, string, Buffer]> {
  const chunkSize = Math.min(sampleSize, fileSize);
  const buffer = Buffer.alloc(chunkSize);

  const handle = await open(filepath, "r");
  try {
    await handle.read(buffer, 0, chunkSize, 0);
  } finally {
    await handle.close();
  }

  const filetype = await fileTypeFromBuffer(buffer);

  return [filetype?.mime ?? "", filetype?.ext ?? "", buffer];
}

const BINARY_FILE_EXTS = new Set([
  "zip",
  "tar",
  "gz",
  "exe",
  "dll",
  "so",
  "class",
  "jar",
  "war",
  "7z",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "bin",
  "dat",
  "obj",
  "o",
  "a",
  "lib",
  "wasm",
  "pyc",
  "pyo",
]);

export function isBinaryFile(ext: string, bytes: Uint8Array) {
  if (BINARY_FILE_EXTS.has(ext)) {
    return true;
  }

  if (bytes.length === 0) {
    return false;
  }

  let nonPrintableCount = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      return true;
    }
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++;
    }
  }

  return nonPrintableCount / bytes.length > 0.3;
}
