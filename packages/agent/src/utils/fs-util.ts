/* oxlint-disable */
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as pathResolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { fileTypeFromBuffer } from "file-type";

export function windowsPath(p: string): string {
  return p
    .replace(
      /^\/([a-zA-Z]):(?:[\\/]|$)/,
      (_, drive) => `${drive.toUpperCase()}:/`
    )
    .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(
      /^\/cygdrive\/([a-zA-Z])(?:\/|$)/,
      (_, drive) => `${drive.toUpperCase()}:/`
    )
    .replace(
      /^\/mnt\/([a-zA-Z])(?:\/|$)/,
      (_, drive) => `${drive.toUpperCase()}:/`
    );
}

export function normalizePath(p: string): string {
  if (process.platform !== "win32") {
    return posix.normalize(p);
  }
  const resolved = pathResolve(windowsPath(p));
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * 把模型给出的路径归一化成文件系统能直接使用的形式：
 * - Unicode 空格（不换行空格、全角空格等）换成普通空格
 * - 去掉 CLI 风格的 `@` 前缀
 * - 展开开头的 `~`
 * - 把 `file://` URL 转成本地路径
 *
 * 与 `normalizeForFuzzyMatch` 里的空格处理保持一致，否则同一个路径在
 * “匹配文本”和“定位文件”两条链路上会得到不同结果。
 */
export function normalizeToolInputPath(filepath: string): string {
  let normalized = filepath.replace(UNICODE_SPACES, " ");

  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }

  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return join(homedir(), normalized.slice(2));
  }

  if (normalized.startsWith("file://")) {
    return fileURLToPath(normalized);
  }

  return normalized;
}

/**
 * Resolves a path supplied by a tool call against the agent's working
 * directory.
 *
 * Relative paths are resolved rather than rejected: the agent only has one
 * base to resolve against, so rejecting would cost a round trip without
 * removing any ambiguity.
 */
export function resolveToolPath(
  filepath: string,
  workdir: string
): { absolute: string } {
  const input = normalizeToolInputPath(filepath);
  const absolute = normalizePath(
    isAbsolute(input) ? input : pathResolve(workdir, input)
  );

  return { absolute };
}

/**
 * Describes a `path` parameter for tool input schemas.
 *
 * Kept beside {@link resolveToolPath} because the two must agree: this
 * sentence is the only place the model learns how relative paths are treated.
 */
export function toolPathDescription(target: string): string {
  return `The path to the ${target}. Relative paths are resolved against the working directory; a leading "~", a leading "@", and "file://" URLs are also accepted.`;
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
    if (bytes[i]! < 9 || (bytes[i]! > 13 && bytes[i]! < 32)) {
      nonPrintableCount++;
    }
  }

  return nonPrintableCount / bytes.length > 0.3;
}

/**
 * Wraps a value in POSIX single-quotes, escaping any embedded single-quotes.
 *
 * The quoting strategy is the standard POSIX approach: wrap the value in
 * single-quotes and replace each embedded `'` with `'\''` (end the
 * single-quoted string, insert an escaped single-quote, re-open
 * single-quoting).
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll(/'/g, "'\\''")}'`;
}
