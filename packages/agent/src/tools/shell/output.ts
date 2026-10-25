import { createWriteStream, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";

import { createToolId, truncateContent } from "../../utils/truncate";

/** Retained tail cap per stream, in bytes. */
export const MAX_OUTPUT_BYTES = 50 * 1024;

/** Retained tail cap per stream, in lines. */
export const MAX_OUTPUT_LINES = 2000;

/** Upper bound for a spill file, so a runaway command cannot fill the disk. */
export const MAX_SPILL_BYTES = 64 * 1024 * 1024;

/**
 * Rolling bytes kept per stream before final truncation. Twice the retained cap
 * leaves enough context for the line-based tail truncation to find a clean
 * boundary.
 */
export type ShellChannel = "stdout" | "stderr";

export interface ShellOutputSnapshot {
  /** Retained stdout tail. */
  stdout: string;
  /** Retained stderr tail. */
  stderr: string;
  /** Whether either stream exceeded its retention limit. */
  truncated: boolean;
  /** Complete output (or the part that fit under the spill cap), when truncated. */
  spillPath?: string;
  /** Whether the spill file itself hit {@link MAX_SPILL_BYTES}. */
  spillTruncated?: boolean;
  /** Whether the spill file could not be written at all. */
  spillFailed?: boolean;
}

interface StreamBuffer {
  readonly decoder: TextDecoder;
  tail: string;
  tailBytes: number;
  totalBytes: number;
  newlines: number;
  lastCharIsNewline: boolean;
  truncated: boolean;
}

function emptyStream(): StreamBuffer {
  return {
    decoder: new TextDecoder(),
    tail: "",
    tailBytes: 0,
    totalBytes: 0,
    newlines: 0,
    lastCharIsNewline: false,
    truncated: false,
  };
}

/** Count newline characters without allocating an array per chunk. */
function countNewlines(text: string): number {
  let count = 0;
  for (
    let index = text.indexOf("\n");
    index !== -1;
    index = text.indexOf("\n", index + 1)
  ) {
    count += 1;
  }
  return count;
}

/**
 * Cut a string down to its last `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character. Continuation bytes are `10xxxxxx`, so the start is moved
 * forward until it lands on a character boundary.
 */
function trimToBytesFromEnd(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf-8");
  if (buffer.length <= maxBytes) {
    return text;
  }
  let start = buffer.length - maxBytes;
  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf-8");
}

/**
 * Collects stdout/stderr of one shell call with bounded memory.
 *
 * Each stream keeps a rolling tail; once a stream exceeds its byte or line
 * limit the collector switches to spilling the raw bytes (both streams, in
 * arrival order) to a file under the session directory. Trailing output is what
 * the model gets, because a failing command states the reason last.
 */
export class ShellOutputCollector {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly maxLines: number;
  private readonly maxSpillBytes: number;

  private readonly stdoutBuffer: StreamBuffer = emptyStream();
  private readonly stderrBuffer: StreamBuffer = emptyStream();

  private rawChunks: Buffer[] = [];
  private spillStream: WriteStream | undefined;
  private spillPath: string | undefined;
  private spillFailed = false;
  private spillTruncated = false;
  private spilledBytes = 0;

  private finishing: Promise<ShellOutputSnapshot> | undefined;

  constructor(options: {
    dir: string;
    maxBytes?: number;
    maxLines?: number;
    maxSpillBytes?: number;
  }) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
    this.maxLines = options.maxLines ?? MAX_OUTPUT_LINES;
    this.maxSpillBytes = options.maxSpillBytes ?? MAX_SPILL_BYTES;
  }

  /** Feed one chunk of a stream. Chunks may split a multi-byte character. */
  push(channel: ShellChannel, chunk: Buffer): void {
    if (this.finishing !== undefined || chunk.length === 0) {
      return;
    }

    const stream = channel === "stdout" ? this.stdoutBuffer : this.stderrBuffer;
    stream.totalBytes += chunk.length;

    if (this.spillPath === undefined && !this.spillFailed) {
      this.rawChunks.push(chunk);
    } else {
      this.writeSpill(chunk);
    }

    this.appendDecoded(stream, stream.decoder.decode(chunk, { stream: true }));
    this.checkLimits(stream);
  }

  /**
   * Flush decoders, close the spill file, and return the model-facing snapshot.
   * Idempotent: a second call resolves to the same snapshot, so an error path
   * can close the spill without changing the outcome.
   */
  finish(): Promise<ShellOutputSnapshot> {
    this.finishing ??= this.flush();
    return this.finishing;
  }

  private async flush(): Promise<ShellOutputSnapshot> {
    this.appendDecoded(this.stdoutBuffer, this.stdoutBuffer.decoder.decode());
    this.appendDecoded(this.stderrBuffer, this.stderrBuffer.decoder.decode());
    await this.closeSpill();

    const truncated =
      this.stdoutBuffer.truncated || this.stderrBuffer.truncated;
    return {
      stdout: this.snapshotStream(this.stdoutBuffer),
      stderr: this.snapshotStream(this.stderrBuffer),
      truncated,
      ...(this.spillPath === undefined ? {} : { spillPath: this.spillPath }),
      ...(this.spillTruncated ? { spillTruncated: true } : {}),
      ...(this.spillFailed ? { spillFailed: true } : {}),
    };
  }

  private appendDecoded(stream: StreamBuffer, text: string): void {
    if (text.length === 0) {
      return;
    }
    stream.tail += text;
    stream.tailBytes += Buffer.byteLength(text, "utf-8");
    stream.newlines += countNewlines(text);
    stream.lastCharIsNewline = text.endsWith("\n");
    const retainedBytes = this.maxBytes * 2;
    if (stream.tailBytes > retainedBytes) {
      stream.tail = trimToBytesFromEnd(stream.tail, retainedBytes);
      stream.tailBytes = Buffer.byteLength(stream.tail, "utf-8");
    }
  }

  private checkLimits(stream: StreamBuffer): void {
    const lines = stream.newlines + (stream.lastCharIsNewline ? 0 : 1);
    if (stream.totalBytes > this.maxBytes || lines > this.maxLines) {
      stream.truncated = true;
      this.ensureSpill();
    }
  }

  private snapshotStream(stream: StreamBuffer): string {
    if (!stream.truncated) {
      return stream.tail;
    }
    // The trailing newline is part of the output, but counting it as an extra
    // empty line would push one real line out of the retained tail.
    const endsWithNewline = stream.tail.endsWith("\n");
    const content = endsWithNewline ? stream.tail.slice(0, -1) : stream.tail;
    const truncated = truncateContent({
      content,
      maxBytes: this.maxBytes,
      maxLines: this.maxLines,
      direction: "tail",
    });
    // A single line longer than the byte cap has no complete line to keep;
    // fall back to its last bytes so the tail is not silently empty.
    if (truncated.lines.length === 0 && stream.tail.length > 0) {
      return trimToBytesFromEnd(stream.tail, this.maxBytes);
    }
    const text = truncated.lines.join("\n");
    return endsWithNewline ? `${text}\n` : text;
  }

  /** Open the spill file lazily, writing everything buffered so far. */
  private ensureSpill(): void {
    if (this.spillPath !== undefined || this.spillFailed) {
      return;
    }
    try {
      const directory = join(this.dir, "shell");
      mkdirSync(directory, { recursive: true });
      const filepath = join(directory, `${createToolId()}.txt`);
      const stream = createWriteStream(filepath, { flags: "wx" });
      stream.on("error", () => {
        this.spillFailed = true;
        this.spillStream = undefined;
      });
      this.spillPath = filepath;
      this.spillStream = stream;
      for (const chunk of this.rawChunks) {
        this.writeSpill(chunk);
      }
      this.rawChunks = [];
    } catch {
      // A spill is a recovery aid, never the command's outcome: keep the tail.
      this.spillFailed = true;
    }
  }

  private writeSpill(chunk: Buffer): void {
    const stream = this.spillStream;
    if (stream === undefined) {
      return;
    }
    const remaining = this.maxSpillBytes - this.spilledBytes;
    if (remaining <= 0) {
      this.spillTruncated = true;
      return;
    }
    if (chunk.length > remaining) {
      stream.write(chunk.subarray(0, remaining));
      this.spilledBytes += remaining;
      this.spillTruncated = true;
      return;
    }
    stream.write(chunk);
    this.spilledBytes += chunk.length;
  }

  private async closeSpill(): Promise<void> {
    const stream = this.spillStream;
    if (stream === undefined) {
      return;
    }
    this.spillStream = undefined;
    await new Promise<void>((resolve) => {
      stream.once("error", () => {
        resolve();
      });
      stream.once("close", () => {
        resolve();
      });
      stream.end();
    });
  }
}
