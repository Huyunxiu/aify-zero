import type {
  AgentStep,
  AgentTurnStatus,
  LedgerRecord,
} from "@workspace/agent-client";
import type { ToolSet } from "ai";

/** One step of a replayed turn. */
export type ReplayedStep = {
  stepId: string;
  /** The status its `step.finish` reported, or nothing while it is still open. */
  status?: AgentTurnStatus["status"];
  /** The whole step, taken from `note.step.settled`. Absent when none was recorded. */
  content?: AgentStep<ToolSet>;
};

export type ReplayedTurn = {
  turnId: string;
  status: "open" | "done";
  steps: ReplayedStep[];
};

export type ReplayedRun = {
  streamId: string;
  status: "open" | "done";
  failure?: string;
  turns: ReplayedTurn[];
};

export type ReplayedLedger = {
  runs: ReplayedRun[];
  /** The facts, in the order the file holds them, for the annotations a timeline draws. */
  notes: LedgerRecord[];
  /** Records whose family this build does not know. Kept out of the timeline, never thrown. */
  unreadable: LedgerRecord[];
};

/**
 * Builds the timeline a replay shows.
 *
 * Two passes, and the order matters: the events give the structure and the notes give the
 * content. Content can arrive after the event that describes it, and a `step.metadata` can
 * add a second `note.step.settled` for one step, so the last one wins.
 *
 * A record this build does not know is separated out rather than thrown: the ledger outlives
 * the code that wrote it.
 */
export function replayLedger(records: readonly LedgerRecord[]): ReplayedLedger {
  const runs: ReplayedRun[] = [];
  const notes: LedgerRecord[] = [];
  const unreadable: LedgerRecord[] = [];
  const current = new Map<string, ReplayedRun>();
  const settled = new Map<string, AgentStep<ToolSet>>();
  const order: string[] = [];

  for (const record of records) {
    if (record.type.startsWith("note.")) {
      notes.push(record);
      if (record.type === "note.step.settled") {
        settled.set(record.stepId, record.content);
        order.push(record.stepId);
      }
      continue;
    }

    if (!record.type.startsWith("stream.")) {
      unreadable.push(record);
      continue;
    }

    if (record.type === "stream.run.start") {
      const run: ReplayedRun = {
        streamId: record.streamId,
        status: "open",
        turns: [],
      };
      runs.push(run);
      current.set(record.streamId, run);
      continue;
    }

    if (record.type === "stream.run.event") {
      applyEvent(current.get(record.streamId), record.event);
      continue;
    }

    if (record.type === "stream.run.end") {
      const run = current.get(record.streamId);
      if (run) {
        run.status = "done";
        if (record.failure !== undefined) {
          run.failure = record.failure;
        }
      }
      continue;
    }

    // A stream family this build does not know: kept, not guessed at.
    unreadable.push(record);
  }

  for (const stepId of order) {
    const content = settled.get(stepId);
    for (const run of runs) {
      for (const turn of run.turns) {
        for (const step of turn.steps) {
          if (step.stepId === stepId && content !== undefined) {
            step.content = content;
          }
        }
      }
    }
  }

  return { runs, notes, unreadable };
}

/** Folds one event into the structure. Unrelated events change nothing. */
function applyEvent(
  run: ReplayedRun | undefined,
  event: { type: string } & Record<string, unknown>
): void {
  if (run === undefined) {
    return;
  }

  switch (event.type) {
    case "turn.start": {
      const { turnId } = event;
      if (typeof turnId === "string") {
        run.turns.push({ turnId, status: "open", steps: [] });
      }
      break;
    }
    case "step.start": {
      const { stepId } = event;
      if (typeof stepId === "string") {
        const turn = run.turns.at(-1);
        turn?.steps.push({ stepId });
      }
      break;
    }
    case "step.finish": {
      const { stepId } = event;
      const { status } = event;
      if (typeof stepId !== "string" || typeof status !== "string") {
        break;
      }
      const step = findStep(run, stepId);
      if (step !== undefined) {
        step.status = status as AgentTurnStatus["status"];
      }
      break;
    }
    case "turn.finish": {
      const turn = run.turns.at(-1);
      if (turn !== undefined) {
        turn.status = "done";
      }
      break;
    }
    default: {
      break;
    }
  }
}

function findStep(run: ReplayedRun, stepId: string): ReplayedStep | undefined {
  for (const turn of run.turns) {
    for (const step of turn.steps) {
      if (step.stepId === stepId) {
        return step;
      }
    }
  }
  return undefined;
}
