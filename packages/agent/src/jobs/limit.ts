import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 单次任务结果给模型的默认字节上限，与前台 shell 的输出上限一致。 */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 50 * 1024;

const encoder = new TextEncoder();

/** 一段文本的 UTF-8 字节数。 */
export const utf8Bytes = (text: string): number =>
  encoder.encode(text).byteLength;

/**
 * 取一段文本的 UTF-8 安全尾巴。
 *
 * 按字节从尾部保留，并向前退到字符边界，不切坏多字节字符。
 * @param text - 原文本。
 * @param maxBytes - 保留的最大字节数。
 */
export const tailBytes = (text: string, maxBytes: number): string => {
  const buffer = Buffer.from(text, "utf-8");
  if (buffer.length <= maxBytes) {
    return text;
  }
  let start = buffer.length - maxBytes;
  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf-8");
};

/** 一次结果裁剪的产物；`truncated` 为真时正文是尾巴。 */
export type FittedText = {
  text: string;
  truncated: boolean;
};

/**
 * 把正文和固定后缀一起塞进字节上限。
 *
 * 超出时保留正文尾巴，后缀（状态行、裁剪提示）永远留在最后；提示里给出
 * 完整输出文件，没有文件时明说不可用。
 * @param input.body - 正文，不含状态行。
 * @param input.suffix - 必须保留的结尾，通常以换行开头。
 * @param input.limitBytes - 完整结果的字节上限。
 * @param input.spillPath - 完整输出文件的宿主路径。
 */
export const fitJobResult = ({
  body,
  suffix,
  limitBytes,
  spillPath,
}: {
  body: string;
  suffix: string;
  limitBytes: number;
  spillPath?: string;
}): FittedText => {
  const complete = `${body}${suffix}`;
  if (utf8Bytes(complete) <= limitBytes) {
    return { text: complete, truncated: false };
  }

  const notice = `\n[output truncated; full output: ${spillPath ?? "(unavailable)"}]`;
  const fixed = `${notice}${suffix}`;
  const fixedBytes = utf8Bytes(fixed);
  if (fixedBytes >= limitBytes) {
    // 连提示都放不下：只能保留最后一段，不再声明文件。
    return { text: tailBytes(complete, limitBytes), truncated: true };
  }

  const tail = tailBytes(body, limitBytes - fixedBytes);
  return { text: `${tail}${fixed}`, truncated: true };
};

/**
 * 把一次读取的完整结果写进会话目录，供模型稍后用文件工具打开。
 * @param input.dir - 会话目录。
 * @param input.jobId - 任务 id，用作文件名。
 * @param input.text - 完整结果。
 * @returns 文件路径；写失败时返回 undefined。
 */
export const writeJobResultFile = ({
  dir,
  jobId,
  text,
}: {
  dir: string;
  jobId: string;
  text: string;
}): string | undefined => {
  const target = join(dir, "jobs");
  try {
    mkdirSync(target, { recursive: true });
    const path = join(target, `${jobId}.log`);
    writeFileSync(path, text, "utf-8");
    return path;
  } catch {
    return undefined;
  }
};
