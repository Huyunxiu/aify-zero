import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

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

import { ledgerPath, ledgerPromptDir, ledgerPromptPath } from "./layout";
import { LedgerWriter } from "./writer";

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
  turnId: string;
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

    // 每一步的边界推一次盘：断电最多丢当前这一步，而不是整段运行。
    this.#writers.get(sessionId)?.settle();
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

    // 一个从没落定的步骤把打字过程留在这里：中途被停、进程要退出，都是它。这
    // 正是要复现的那种现场，所以倒出来而不是丢掉。
    for (const [key, held] of this.#buffers) {
      if (!key.startsWith(`${sessionId}\u0000`)) {
        continue;
      }
      this.#buffers.delete(key);
      const stepId = key.slice(sessionId.length + 1);
      this.#write(sessionId, epoch, {
        type: "note.step.delta-backlog",
        turnId: held.turnId,
        stepId,
        truncated: held.truncated,
        chunks: held.chunks,
      });
    }
  }

  /**
   * Records what one turn ran under: the model, the effort, the policy, and the prompt.
   *
   * The prompt is stored by digest, so a session with the same prompt on every turn keeps
   * one copy of it. The record keeps the digest and the blocks that built the prompt,
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
    // 正文存不下来时仍然写这条记录：摘要是对的，缺的只是那份文件。少了模型和
    // 审批策略，这条记录就白记了，而这正是它存在的理由。
    const instructions = this.#storePrompt(
      sessionId,
      settings.instructions.text
    );

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
    this.#dropBuffers(sessionId);
  }

  close(): void {
    for (const writer of this.#writers.values()) {
      writer?.close();
    }
    this.#writers.clear();
    this.#buffers.clear();
  }

  /**
   * Forgets one session's pending typing.
   *
   * Only that session's: a main session and a subagent run at the same time, and closing
   * one file must not throw away the other's evidence.
   */
  #dropBuffers(sessionId: string): void {
    for (const key of this.#buffers.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) {
        this.#buffers.delete(key);
      }
    }
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
    event: AgentStreamEvent<ToolSet> & { stepId: string; turnId: string }
  ): void {
    const key = bufferKey(sessionId, event.stepId);
    const held = this.#buffers.get(key) ?? {
      turnId: event.turnId,
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

  /** Stores one system prompt and answers its address. A digest names the bytes. */
  #storePrompt(
    sessionId: string,
    text: string
  ): { sha256: string; bytes: number } {
    const sha256 = digestOf(text);
    const sessionDir = this.#options.dirOf(sessionId);

    try {
      mkdirSync(ledgerPromptDir(sessionDir), { recursive: true });
      // The digest names the bytes, so the same prompt twice is the same file.
      writeFileSync(ledgerPromptPath(sessionDir, sha256), text, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        this.#unopened += 1;
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
        path: ledgerPath(this.#options.dirOf(sessionId)),
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
