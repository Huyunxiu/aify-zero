import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { nanoid } from "nanoid";

/** 7 days in milliseconds */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LINES = 2000;
/** 50 KB */
const DEFAULT_MAX_BYTES = 50 * 1024;

export function createToolId(): string {
  return `tool_${Date.now()}_${nanoid(12)}`;
}

export function timestampFromId(id: string): number {
  const [num] = id.replace(/^tool_/u, "").split("_");
  return Number(num) || 0;
}

export interface TruncateOptions {
  dir: string;
  retentionMs?: number;
  maxBytes?: number;
  maxLines?: number;
  hasTaskTool?: boolean;
  direction?: "head" | "tail";
}

export type TruncateResult =
  | { content: string; truncated: false }
  | { content: string; truncated: true; outputPath: string };

export interface TruncateLimits {
  maxLines: number;
  maxBytes: number;
}

export class Truncate {
  private readonly dir: string;
  private readonly retentionMs: number;
  private readonly maxBytes: number;
  private readonly maxLines: number;
  private readonly hasTaskTool?: boolean;
  private readonly direction?: "head" | "tail";

  constructor({
    dir,
    retentionMs = RETENTION_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxLines = DEFAULT_MAX_LINES,
    hasTaskTool = false,
    direction = "head",
  }: TruncateOptions) {
    this.dir = dir;
    this.retentionMs = retentionMs;
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
    this.hasTaskTool = hasTaskTool;
    this.direction = direction;
  }

  limits(maxLines?: number, maxBytes?: number): TruncateLimits {
    return {
      maxBytes: maxBytes ?? DEFAULT_MAX_BYTES,
      maxLines: maxLines ?? DEFAULT_MAX_LINES,
    };
  }

  async write(filename: string, text: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const filepath = path.join(this.dir, `${filename}.txt`);
    await writeFile(filepath, text, "utf-8");
    return filepath;
  }

  async output(text: string): Promise<TruncateResult> {
    const lines: string[] = text.split("\n");
    const totalBytes = Buffer.byteLength(text, "utf-8");

    if (lines.length <= this.maxLines && totalBytes <= this.maxBytes) {
      return { content: text, truncated: false };
    }

    const out: string[] = [];
    let bytes = 0;
    let hitBytes = false;

    if (this.direction === "head") {
      for (const line of lines) {
        if (out.length >= this.maxLines) {
          break;
        }
        const newlineCost = out.length > 0 ? 1 : 0;
        const size = Buffer.byteLength(line, "utf-8") + newlineCost;
        if (bytes + size > this.maxBytes) {
          hitBytes = true;
          break;
        }
        out.push(line);
        bytes += size;
      }
    } else {
      for (
        let i = lines.length - 1;
        i >= 0 && out.length < this.maxLines;
        i -= 1
      ) {
        const line: string = lines.at(i) ?? "";
        const newlineCost = out.length > 0 ? 1 : 0;
        const size = Buffer.byteLength(line, "utf-8") + newlineCost;
        if (bytes + size > this.maxBytes) {
          hitBytes = true;
          break;
        }
        out.unshift(line);
        bytes += size;
      }
    }

    const removed = hitBytes ? totalBytes - bytes : lines.length - out.length;
    const unit = hitBytes ? "bytes" : "lines";
    const preview = out.join("\n");
    const file = await this.write(createToolId(), text);

    const hint = this.hasTaskTool
      ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
      : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`;

    return {
      content:
        this.direction === "head"
          ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
          : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`,
      outputPath: file,
      truncated: true,
    } as const;
  }

  async cleanup(): Promise<void> {
    const cutoff = Date.now() - this.retentionMs;

    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      /* directory doesn't exist yet */
      return;
    }

    const tasks = entries
      .filter((name) => name.startsWith("tool_"))
      .filter((name) => timestampFromId(name) < cutoff)
      .map(async (name) => {
        await rm(path.join(this.dir, name), { force: true });
      });

    await Promise.allSettled(tasks);
  }
}
