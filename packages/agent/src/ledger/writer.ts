import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { LEDGER_VERSION } from "@workspace/agent-client";
import type { LedgerPayload, LedgerRecord } from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";

import { parseLedgerLine } from "./reader";

/** How far back one step of the resume reads, in bytes. */
const TAIL_CHUNK = 64 * 1024;

/** The byte that ends a line. No other byte of a UTF-8 sequence can hold this value. */
const NEWLINE = 0x0a;

export type LedgerWriterOptions = {
  /** The ledger file. Its directory is created when it is absent. */
  path: string;
  /** The clock, so a test can make time stand still. */
  now?: () => number;
};

/**
 * Where a file stops.
 *
 * `line` is the highest number the file has used, and it counts a number that a line which a
 * crash cut in half took: that line keeps its number, so no later record repeats it.
 * `atLineStart` answers whether the file ends where a line begins: false means the last line
 * has no newline, and the writer closes it.
 */
type Resume = {
  line: number;
  atLineStart: boolean;
};

/**
 * Appends records to one session ledger.
 *
 * The file is written first and a step settles after it, so a process that dies loses at
 * most the last record. A failed append is counted and never thrown: the ledger is evidence,
 * and evidence that breaks the thing it observes is worse than missing evidence.
 *
 * The file is always a sequence of whole lines. A record is written together with the newline
 * that ends it, and a line that a crash cut in half is closed before the next record starts,
 * so the record after it is whole. A line number is spent when it is taken, so the numbers
 * only move forward and a missing number shows a record that never reached the disk.
 *
 * Writes are synchronous on purpose. One record is a short line, and ordering matters more
 * than a blocked tick.
 */
export class LedgerWriter {
  readonly #descriptor: number;
  readonly #now: () => number;
  #line = 0;
  #atLineStart = true;
  #failures = 0;

  private constructor(options: LedgerWriterOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.#descriptor = openSync(options.path, "a+");
    this.#now = options.now ?? Date.now;

    // A file that cannot be resumed cannot be appended to either, because the next record
    // would lie about its number. One descriptor, so the read and the writes agree.
    try {
      const resume = resumeAt(this.#descriptor);
      this.#line = resume.line;
      this.#atLineStart = resume.atLineStart;
    } catch (error) {
      closeSync(this.#descriptor);
      throw error;
    }
  }

  /**
   * Opens the file and continues the line numbers it already holds.
   *
   * It throws when the file cannot be opened, and the caller decides what that means: one
   * place turns a missing ledger into "this session records nothing".
   */
  static open(options: LedgerWriterOptions): LedgerWriter {
    return new LedgerWriter(options);
  }

  /** How many writes failed. A failure is counted and logged, and never thrown. */
  get failures(): number {
    return this.#failures;
  }

  /**
   * Writes one record.
   *
   * `epoch` comes with each record because one file holds many channel instances: a
   * channel is dropped when its session goes idle, and the next run opens a new one.
   */
  append(payload: LedgerPayload, epoch: string | null): void {
    const line = this.#line + 1;
    // The number is spent here, written or not: no two records may share one.
    this.#line = line;

    const record = {
      line,
      v: LEDGER_VERSION,
      at: this.#now(),
      epoch,
      ...payload,
    } as LedgerRecord;

    const body = `${JSON.stringify(record)}\n`;
    const text = this.#atLineStart ? body : `\n${body}`;
    const written = this.#writeAll(text);
    // The file moves only when bytes land. A write that took nothing leaves it where it was.
    if (written > 0) {
      this.#atLineStart = written === Buffer.byteLength(text);
    }
  }

  /** Pushes the bytes to the disk. A step boundary calls this. */
  settle(): void {
    try {
      fsyncSync(this.#descriptor);
    } catch {
      this.#fail("failed to flush a record");
    }
  }

  close(): void {
    this.settle();
    try {
      closeSync(this.#descriptor);
    } catch {
      this.#fail("failed to close the ledger");
    }
  }

  /**
   * Writes the text, and answers how many bytes reached the file.
   *
   * A short write is not a lost record. A disk that fills up takes the bytes it can and then
   * fails, and a write that a signal cuts comes back short when one more attempt would finish
   * it, so the rest is retried until an attempt makes no progress.
   */
  #writeAll(text: string): number {
    const bytes = Buffer.from(text, "utf-8");
    let offset = 0;

    while (offset < bytes.length) {
      let written: number;
      try {
        written = writeSync(this.#descriptor, bytes, offset);
      } catch (error) {
        this.#fail("failed to append a record", error);
        return offset;
      }
      if (written === 0) {
        this.#fail("the file took no bytes of a record");
        return offset;
      }
      offset += written;
    }

    return offset;
  }

  /**
   * Counts a failure and says so.
   *
   * The count says nothing to anyone on its own: a broken ledger becomes "no replay", not an
   * error, so one warning is what is left to read.
   */
  #fail(message: string, error?: unknown): void {
    this.#failures += 1;
    if (error === undefined) {
      logger.warn(`[ledger] ${message}`);
    } else {
      logger.warn(`[ledger] ${message}`, error);
    }
  }
}

/**
 * Where the file stops.
 *
 * A file that ends without a newline holds a line that a crash cut in half. That line is a
 * whole record when it parses, and the writer only closes it. When it does not parse, the
 * line took the number after the last whole one, and that number stays spent: the next
 * record takes one more, so the numbers keep moving forward.
 */
function resumeAt(descriptor: number): Resume {
  const { size } = fstatSync(descriptor);
  if (size === 0) {
    return { line: 0, atLineStart: true };
  }

  const atLineStart = readBytes(descriptor, size - 1, 1)[0] === NEWLINE;
  if (atLineStart) {
    return { line: lastLine(descriptor, size), atLineStart };
  }

  const cut = lastNewlineEnd(descriptor, size);
  const text = readBytes(descriptor, cut, size - cut).toString("utf-8");
  const line = parseLedgerLine(text);
  if (line !== null) {
    return { line: line.line, atLineStart };
  }

  return { line: lastLine(descriptor, cut) + 1, atLineStart };
}

/**
 * The highest line number a region holds, or 0 when no line in it parses.
 *
 * The region is read from its end, one window at a time, and the walk stops at the first line
 * that parses. A line number cannot come from a byte offset, so it must come from a record.
 * One record can be larger than a window, which is why the walk goes back instead of giving up.
 */
function lastLine(descriptor: number, end: number): number {
  let position = end;
  /** The bytes of a line whose left part is not read yet. */
  let carry = Buffer.alloc(0);

  while (position > 0) {
    const start = Math.max(0, position - TAIL_CHUNK);
    const chunk = readBytes(descriptor, start, position - start);
    const window = Buffer.concat([chunk, carry]);
    const pieces = window.toString("utf-8").split("\n");

    // Every piece but the first starts just after a newline, so it is a whole line: the first
    // one is cut on its left by the window. A line cut on its left cannot pass, because `line`
    // is the first field of a record.
    const first = start === 0 ? 0 : 1;
    for (let index = pieces.length - 1; index >= first; index -= 1) {
      const record = parseLedgerLine(pieces[index] ?? "");
      if (record !== null) {
        return record.line;
      }
    }

    const newline = window.indexOf(NEWLINE);
    carry = window.subarray(0, newline === -1 ? window.length : newline);
    position = start;
  }

  return 0;
}

/** The offset just after the last newline below `end`, or 0 when the region holds none. */
function lastNewlineEnd(descriptor: number, end: number): number {
  let position = end;
  while (position > 0) {
    const start = Math.max(0, position - TAIL_CHUNK);
    const chunk = readBytes(descriptor, start, position - start);
    const newline = chunk.lastIndexOf(NEWLINE);
    if (newline !== -1) {
      return start + newline + 1;
    }
    position = start;
  }
  return 0;
}

/** Reads a range of the file. A short read leaves the rest of the buffer out. */
function readBytes(
  descriptor: number,
  position: number,
  length: number
): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;

  while (read < length) {
    const count = readSync(
      descriptor,
      buffer,
      read,
      length - read,
      position + read
    );
    if (count === 0) {
      break;
    }
    read += count;
  }

  return buffer.subarray(0, read);
}
