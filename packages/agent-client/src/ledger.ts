import type { ModelEffort } from "@workspace/shared/constants";
import type { ModelRef } from "@workspace/shared/model";
import type { ToolSet } from "ai";

import type { ApprovalPolicy } from "./approval-policy";
import type { DeliverAt, InboxKind } from "./inbox";
import type { AgentStep, AgentStreamEvent, AgentUserTurn } from "./types";

/**
 * The format version of one ledger line.
 *
 * It is a constant type rather than a number: the writer puts a literal `2` into a record
 * when the format changes, and that stops compiling until someone means it. The version is
 * on each line, so an old line keeps its old shape in a file that already holds new ones.
 */
export const LEDGER_VERSION = 1 as const;

/**
 * The event types the ledger does not record.
 *
 * The stream shows the typing, and a replay does not need it: the settled step holds the
 * text. These three are buffered in memory instead and written only when a step fails, so
 * the list is a list of what to skip rather than a list of what to keep. A new event type
 * is therefore recorded by default, which is the safe direction for a record.
 */
export const DELTA_EVENT_TYPES = [
  "text.delta",
  "reasoning.delta",
  "tool.input-delta",
] as const;

export type DeltaEventType = (typeof DELTA_EVENT_TYPES)[number];

/** Whether this event is typing rather than a settled fact. */
export function isDeltaEvent(
  event: AgentStreamEvent<ToolSet>
): event is AgentStreamEvent<ToolSet> & { type: DeltaEventType } {
  return (DELTA_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * The two families a record belongs to. The first dot of `type` splits them.
 *
 * The family decides the reader's path and nothing else: a stream record feeds the
 * projection, and a note becomes an annotation. A reader keeps an unknown member and skips
 * an unknown family, so a later addition does not break an older reader.
 */
export type LedgerFamily = "stream" | "note";

/** The family of a record, or nothing when this reader does not know the name. */
export function ledgerFamily(type: string): LedgerFamily | undefined {
  const dot = type.indexOf(".");
  const family = dot === -1 ? "" : type.slice(0, dot);
  return family === "stream" || family === "note" ? family : undefined;
}

/** The fields every line carries. */
type Line = {
  /** Address of the record. Starts at 1 and never resets, so a jump proves a missing line. */
  line: number;
  v: typeof LEDGER_VERSION;
  /** Write time, epoch milliseconds. The wall-clock axis of a replay. */
  at: number;
  /** The channel instance. Null before a process has taken the session. */
  epoch: string | null;
};

/** A stream record also names the attempt it belongs to. */
type StreamLine = Line & { streamId: string };

/**
 * The process on the screen.
 *
 * A replay rebuilds the session panel from these, which is why `run.event` keeps the event
 * unchanged: the code that assembles a turn already reads that shape.
 */
export type StreamRecord =
  | (StreamLine & {
      type: "stream.run.start";
      /** The turns this run claimed, in the order of the transcript. */
      turnIds?: readonly string[];
      /** Their content. A user turn holds no step, so this is where its body enters. */
      turns?: readonly AgentUserTurn[];
    })
  | (StreamLine & {
      type: "stream.run.event";
      event: AgentStreamEvent<ToolSet>;
    })
  | (StreamLine & {
      type: "stream.run.end";
      /** Present only when the run failed. An absent line is the crash evidence. */
      failure?: string;
    });

/** A system prompt, by content address. The text is in `ledger/blobs/<sha256>`. */
export type LedgerBlobRef = {
  sha256: string;
  bytes: number;
};

/**
 * A fact the screen never showed.
 *
 * A replay draws these as annotations: they answer why the run started, what it ran under,
 * and what a later action replaced.
 */
export type NoteRecord =
  | (Line & {
      type: "note.process";
      pid: number;
      appVersion: string;
    })
  | (Line & {
      type: "note.inbox.arrived";
      inboxItemId: string;
      /** Imported from the inbox contract, not copied, so a new kind needs no change here. */
      inboxKind: InboxKind;
      dedupeKey: string;
      deliverAt: DeliverAt;
    })
  | (Line & {
      type: "note.inbox.claimed";
      inboxItemId: string;
      turnId: string;
    })
  | (Line & {
      type: "note.inbox.discarded";
      inboxItemId: string;
      reason: string;
    })
  | (Line & {
      type: "note.turn.settings";
      turnId: string;
      streamId: string;
      model: ModelRef;
      /** Absent when the host named no effort for this turn. */
      effort?: ModelEffort;
      approvalPolicy: ApprovalPolicy;
      instructions: LedgerBlobRef;
      /** Which instructions sections built the prompt, in render order. */
      sections: readonly { id: string; priority: number; sha256: string }[];
    })
  | (Line & {
      type: "note.turn.superseded";
      turnId: string;
      /**
       * The attempt that replaced this turn's content.
       *
       * A regenerated turn keeps its id: the same turn row is written again, so the
       * attempt is what changed, not the turn. This record is the only place that says so.
       */
      streamId: string;
    })
  | (Line & {
      type: "note.step.settled";
      turnId: string;
      stepId: string;
      /**
       * The whole step, as the database holds it.
       *
       * One step can appear more than once: once when it settles and again when its
       * metadata arrives. A reader takes the last one.
       */
      content: AgentStep<ToolSet>;
    })
  | (Line & {
      type: "note.step.delta-backlog";
      turnId: string;
      stepId: string;
      /** True when the buffer hit its cap and the typing is incomplete. */
      truncated: boolean;
      chunks: readonly {
        at: number;
        event: AgentStreamEvent<ToolSet>;
      }[];
    })
  | (Line & {
      type: "note.recovery";
      turnId: string;
      reason: string;
    });

/** One line of a session ledger. */
export type LedgerRecord = StreamRecord | NoteRecord;

/** `Omit` over a union, one member at a time. A bare `Omit` collapses the union to its shared keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** What a caller supplies. The writer adds the line fields. */
export type LedgerPayload = DistributiveOmit<
  LedgerRecord,
  "line" | "v" | "at" | "epoch"
>;
