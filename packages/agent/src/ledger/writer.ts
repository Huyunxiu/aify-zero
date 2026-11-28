import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { LEDGER_VERSION } from "@workspace/agent-client";
import type { LedgerPayload, LedgerRecord } from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";

export type LedgerWriterOptions = {
  /** The ledger file. Its directory is created when it is absent. */
  path: string;
  /** The clock, so a test can make time stand still. */
  now?: () => number;
};

/**
 * Appends records to one session ledger.
 *
 * The file is written first and a step settles after it, so a process that dies loses at
 * most the last record. A failed append is counted and never thrown: the ledger is evidence,
 * and evidence that breaks the thing it observes is worse than missing evidence.
 *
 * Writes are synchronous on purpose. One record is a short line, and ordering matters more
 * than a blocked tick.
 */
export class LedgerWriter {
  readonly #descriptor: number;
  readonly #now: () => number;
  #line: number;
  #failures = 0;

  private constructor(options: LedgerWriterOptions, line: number) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.#descriptor = openSync(options.path, "a");
    this.#now = options.now ?? Date.now;
    this.#line = line;
  }

  /**
   * Opens the file and continues the line numbers it already holds.
   *
   * It throws when the file cannot be opened, and the caller decides what that means: one
   * place turns a missing ledger into "this session records nothing".
   */
  static open(options: LedgerWriterOptions): LedgerWriter {
    return new LedgerWriter(options, lastLine(options.path));
  }

  /** How many appends failed. A failure is counted and logged, and never thrown. */
  get failures(): number {
    return this.#failures;
  }

  /** The line the next record takes. */
  get nextLine(): number {
    return this.#line + 1;
  }

  /**
   * Writes one record.
   *
   * `epoch` comes with each record because one file holds many channel instances: a
   * channel is dropped when its session goes idle, and the next run opens a new one.
   */
  append(payload: LedgerPayload, epoch: string | null): void {
    const record = {
      line: this.#line + 1,
      v: LEDGER_VERSION,
      at: this.#now(),
      epoch,
      ...payload,
    } as LedgerRecord;

    try {
      writeSync(this.#descriptor, `${JSON.stringify(record)}\n`);
      this.#line += 1;
    } catch (error) {
      this.#failures += 1;
      // 计数不告诉任何人。流水坏了会变成「没有回放」，而不是一条错误，所以这里
      // 至少留一行日志。
      logger.warn("[ledger] failed to append a record", error);
    }
  }

  /** Pushes the bytes to the disk. A step boundary calls this. */
  settle(): void {
    try {
      fsyncSync(this.#descriptor);
    } catch {
      this.#failures += 1;
    }
  }

  close(): void {
    this.settle();
    try {
      closeSync(this.#descriptor);
    } catch {
      this.#failures += 1;
    }
  }
}

/**
 * The last line number the file holds.
 *
 * A broken line is skipped rather than fatal: a record that cannot be read still ends with a
 * newline, and the numbers after it stay correct.
 */
function lastLine(path: string): number {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return 0;
  }

  let last = 0;
  for (const raw of content.split("\n")) {
    if (raw === "") {
      continue;
    }
    try {
      const value = JSON.parse(raw) as { line?: unknown };
      if (typeof value.line === "number" && value.line > last) {
        last = value.line;
      }
    } catch {
      continue;
    }
  }
  return last;
}
