/* oxlint-disable */
import { open } from "node:fs/promises";
import { homedir } from "node:os";

import type { Sandbox } from "@workspace/sandbox";
import {
  normalizeInputPath,
  resolveSandboxPath,
} from "@workspace/sandbox/paths";
import { fileTypeFromBuffer } from "file-type";

export { normalizePath, windowsPath } from "@workspace/sandbox/paths";

/**
 * 把模型给出的路径归一化成文件系统能直接使用的形式。
 *
 * 规则只有一份，住在沙箱包里：本机适配器的 `resolvePath` 用同一份实现，工具和
 * 框架资源读到的路径因此不会分叉。
 */
export function normalizeToolInputPath(filepath: string): string {
  return normalizeInputPath(filepath, homedir());
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
  projectDir: string
): { absolute: string } {
  return {
    absolute: resolveSandboxPath(filepath, {
      cwd: projectDir,
      home: homedir(),
    }),
  };
}

export function toolPathDescription(target: string): string {
  return `The path to the ${target}. Relative paths are resolved against the working directory; a leading "~", a leading "@", and "file://" URLs are also accepted.`;
}

/** 嗅探文件类型时读的字节数。 */
export const FILE_SAMPLE_BYTES = 4096;

export async function getFileTypeFromBuffer(
  filepath: string,
  fileSize: number,
  sampleSize: number = FILE_SAMPLE_BYTES
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

/**
 * 读文件开头一小段。沙箱有 `readHead` 就用它，没有就退到整份读取再截断——后者
 * 对大文件不友好，所以 `readHead` 是优先能力。
 *
 * @param sandbox - 提供文件的环境。
 * @param path - 已经解析过的绝对路径。
 */
async function readFileHead(
  sandbox: Sandbox,
  path: string
): Promise<Uint8Array> {
  if (sandbox.readHead !== undefined) {
    return await sandbox.readHead(path, FILE_SAMPLE_BYTES);
  }

  const bytes = await sandbox.readFileBuffer(path);

  return bytes.subarray(0, FILE_SAMPLE_BYTES);
}

/**
 * 用文件开头的一段字节判断类型，避免把整份文件读进内存。
 *
 * @param sandbox - 提供文件的环境。
 * @param path - 已经解析过的绝对路径。
 */
export async function getFileTypeFromSandbox(
  sandbox: Sandbox,
  path: string
): Promise<[string, string, Uint8Array]> {
  const head = await readFileHead(sandbox, path);
  const filetype = await fileTypeFromBuffer(head);

  return [filetype?.mime ?? "", filetype?.ext ?? "", head];
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
