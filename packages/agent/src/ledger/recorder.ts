import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  AgentStreamEvent,
  AgentUserTurn,
  ApprovalPolicy,
  LedgerPayload,
} from "@workspace/agent-client";
import { isDeltaEvent } from "@workspace/agent-client";
import type { ModelEffort } from "@workspace/shared/constants";
import type { ModelRef } from "@workspace/shared/model";
import type { ToolSet } from "ai";

import { LedgerWriter } from "./writer";

/** The file a session's ledger lives in, under its own directory. */
export const LEDGER_FILE = "ledger.jsonl";

/** The directory that holds a system prompt, by content address. */
export const LEDGER_BLOB_DIR = join("ledger", "blobs");

/** How much typing one step may hold before the record says it was cut. */
const DEFAULT_DELTA_BUDGET = 256 * 1024;

export type SessionLedgerRecorderOptions = {
  /** The directory that belongs to one session. */
  dirOf: (sessionId: string) => string;
  pid: number;
  appVersion: string;
  now?: () => number;
  /** Bytes of buffered typing per step before the record is marked truncated. */
  deltaBudget?: number;
};

type Buffer = {
  chunks: { at: number; event: AgentStreamEvent<ToolSet> }[];
  bytes: number;
  truncated: boolean;
};

/**
 * Turns the calls of one session's event channel into ledger records.
 *
 * The channel already knows where a run starts and ends, so this object only decides what
 * becomes a line: an event becomes a stream record, a delta waits in memory, and a step that
 * fails turns its waiting into one note. A ledger that cannot be opened for a session leaves
 * that session unrecorded and never touches the run.
 */
export class SessionLedgerRecorder {
  readonly #writers = new Map<string, LedgerWriter | undefined>();
  readonly #announced = new Set<string>();
  readonly #buffers = new Map<string, Buffer>();
  readonly #options: SessionLedgerRecorderOptions;
  /** Sessions whose ledger could not be opened. A silent one is worse than a counted one. */
  #unopened = 0;
  readonly #deltaBudget: number;

  constructor(options: SessionLedgerRecorderOptions) {
    this.#options = options;
    this.#deltaBudget = options.deltaBudget ?? DEFAULT_DELTA_BUDGET;
  }

  /** How many writes failed across the sessions this process recorded. */
  get failures(): number {
    let total = this.#unopened;
    for (const writer of this.#writers.values()) {
      total += writer?.failures ?? 0;
    }
    return total;
  }

  startRun(
    sessionId: string,
    epoch: string,
    streamId: string,
    started: {
      turnIds?: readonly string[];
      turns?: readonly AgentUserTurn[];
    } = {}
  ): void {
    this.#write(sessionId, epoch, {
      type: "stream.run.start",
      streamId,
      ...(started.turnIds === undefined ? {} : { turnIds: started.turnIds }),
      ...(started.turns === undefined ? {} : { turns: started.turns }),
    });
  }

  event(
    sessionId: string,
    epoch: string,
    streamId: string,
    event: AgentStreamEvent<ToolSet>
  ): void {
    if (isDeltaEvent(event)) {
      this.#hold(sessionId, event);
      return;
    }

    this.#write(sessionId, epoch, {
      type: "stream.run.event",
      streamId,
      event,
    });

    if (event.type !== "step.finish") {
      return;
    }
    if (event.status !== "error" && event.status !== "aborted") {
      this.#buffers.delete(bufferKey(sessionId, event.stepId));
      return;
    }

    const held = this.#buffers.get(bufferKey(sessionId, event.stepId));
    if (held === undefined) {
      return;
    }
    this.#buffers.delete(bufferKey(sessionId, event.stepId));
    this.#write(sessionId, epoch, {
      type: "note.step.delta-backlog",
      turnId: event.turnId,
      stepId: event.stepId,
      truncated: held.truncated,
      chunks: held.chunks,
    });
  }

  endRun(
    sessionId: string,
    epoch: string,
    streamId: string,
    failure?: string
  ): void {
    this.#write(sessionId, epoch, {
      type: "stream.run.end",
      streamId,
      ...(failure === undefined ? {} : { failure }),
    });

    // A step that never settled left its typing here. It is not worth keeping past the run
    // that held it, and a session that keeps running must not grow without end.
    for (const key of this.#buffers.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) {
        this.#buffers.delete(key);
      }
    }
  }

  /**
   * Records what one turn ran under: the model, the effort, the policy, and the prompt.
   *
   * The prompt goes into a blob by digest, so a session with the same prompt on every turn
   * keeps one copy of it. The record keeps the digest and the blocks that built the prompt,
   * which is the difference between "the prompt changed" and "this section changed".
   */
  turnSettings(
    sessionId: string,
    epoch: string | null,
    settings: {
      turnId: string;
      streamId: string;
      model: ModelRef;
      effort?: ModelEffort;
      approvalPolicy: ApprovalPolicy;
      instructions: {
        text: string;
        sections: readonly { id: string; priority: number; text: string }[];
      };
    }
  ): void {
    const instructions = this.#blob(sessionId, settings.instructions.text);
    if (instructions === undefined) {
      return;
    }

    this.#write(sessionId, epoch, {
      type: "note.turn.settings",
      turnId: settings.turnId,
      streamId: settings.streamId,
      model: settings.model,
      ...(settings.effort === undefined ? {} : { effort: settings.effort }),
      approvalPolicy: settings.approvalPolicy,
      instructions,
      sections: settings.instructions.sections.map((section) => ({
        id: section.id,
        priority: section.priority,
        sha256: digestOf(section.text),
      })),
    });
  }

  /** Writes one note. The caller holds the fact; this object only places it. */
  note(sessionId: string, epoch: string | null, payload: LedgerPayload): void {
    this.#write(sessionId, epoch, payload);
  }

  /** Closes one session's file. A finished channel calls this, so no descriptor lingers. */
  closeSession(sessionId: string): void {
    this.#writers.get(sessionId)?.close();
    this.#writers.delete(sessionId);
    this.#buffers.clear();
  }

  close(): void {
    for (const writer of this.#writers.values()) {
      writer?.close();
    }
    this.#writers.clear();
    this.#buffers.clear();
  }

  #write(
    sessionId: string,
    epoch: string | null,
    payload: LedgerPayload
  ): void {
    const writer = this.#writerFor(sessionId);
    if (writer === undefined) {
      return;
    }

    if (!this.#announced.has(sessionId)) {
      this.#announced.add(sessionId);
      writer.append(
        {
          type: "note.process",
          pid: this.#options.pid,
          appVersion: this.#options.appVersion,
        },
        epoch
      );
    }

    writer.append(payload, epoch);
  }

  #hold(
    sessionId: string,
    event: AgentStreamEvent<ToolSet> & { stepId: string }
  ): void {
    const key = bufferKey(sessionId, event.stepId);
    const held = this.#buffers.get(key) ?? {
      chunks: [],
      bytes: 0,
      truncated: false,
    };

    const chunk = { at: this.#options.now?.() ?? Date.now(), event };
    const size = JSON.stringify(chunk).length;
    if (held.bytes + size > this.#deltaBudget) {
      held.truncated = true;
      this.#buffers.set(key, held);
      return;
    }

    held.chunks.push(chunk);
    held.bytes += size;
    this.#buffers.set(key, held);
  }

  /** Stores one system prompt and answers where it landed. */
  #blob(
    sessionId: string,
    text: string
  ): { sha256: string; bytes: number } | undefined {
    const sha256 = digestOf(text);
    const directory = join(this.#options.dirOf(sessionId), LEDGER_BLOB_DIR);

    try {
      mkdirSync(directory, { recursive: true });
      // The digest names the bytes, so a second write of the same prompt is the same file.
      writeFileSync(join(directory, sha256), text, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        this.#unopened += 1;
        return undefined;
      }
    }

    return { sha256, bytes: Buffer.byteLength(text) };
  }

  #writerFor(sessionId: string): LedgerWriter | undefined {
    const existing = this.#writers.get(sessionId);
    if (existing !== undefined || this.#writers.has(sessionId)) {
      return existing;
    }

    let writer: LedgerWriter | undefined;
    try {
      writer = LedgerWriter.open({
        path: join(this.#options.dirOf(sessionId), LEDGER_FILE),
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      });
    } catch {
      this.#unopened += 1;
      writer = undefined;
    }

    this.#writers.set(sessionId, writer);
    return writer;
  }
}

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function bufferKey(sessionId: string, stepId: string): string {
  return `${sessionId}\u0000${stepId}`;
}
