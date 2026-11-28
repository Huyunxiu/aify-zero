import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentStep,
  AgentStreamEvent,
  LedgerRecord,
} from "@workspace/agent-client";
import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import { replayLedger } from "../../src/ledger/projection.js";
import { readLedger } from "../../src/ledger/reader.js";
import { SessionLedgerRecorder } from "../../src/ledger/recorder.js";
import { SessionEventRegistry } from "../../src/session-events.js";
import type { AgentToolSet } from "../../src/types.js";

const stepStart = (stepId: string): AgentStreamEvent<AgentToolSet> =>
  ({
    type: "step.start",
    turnId: "t1",
    stepId,
    createdAt: 1,
  }) as AgentStreamEvent<AgentToolSet>;

const stepDone = (stepId: string): AgentStreamEvent<AgentToolSet> =>
  ({
    type: "step.finish",
    turnId: "t1",
    stepId,
    createdAt: 2,
    status: "done",
  }) as AgentStreamEvent<AgentToolSet>;

const turnStart = (): AgentStreamEvent<AgentToolSet> =>
  ({
    type: "turn.start",
    turnId: "t1",
    createdAt: 1,
  }) as AgentStreamEvent<AgentToolSet>;

const turnDone = (): AgentStreamEvent<AgentToolSet> =>
  ({
    type: "turn.finish",
    turnId: "t1",
    createdAt: 3,
    status: "done",
  }) as AgentStreamEvent<AgentToolSet>;

const stepContent = (): AgentStep<ToolSet> =>
  ({
    id: "p1",
    type: "assistant",
    status: { status: "done" },
    content: [{ type: "text", text: "跑完了。", createdAt: 1 }],
  }) as unknown as AgentStep<ToolSet>;

describe("the timeline a replay rebuilds", () => {
  test("takes the structure from the events and the content from the notes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const recorder = new SessionLedgerRecorder({
      dirOf: () => dir,
      pid: 413,
      appVersion: "0.4.1",
    });
    const registry = new SessionEventRegistry<AgentToolSet>(recorder);

    registry.startRun("session-1", "stream-1");
    registry.publish("session-1", "stream-1", turnStart());
    registry.publish("session-1", "stream-1", stepStart("p1"));
    registry.publish("session-1", "stream-1", stepDone("p1"));
    registry.publish("session-1", "stream-1", turnDone());
    // The content arrives after the event: it settles later than the end, which is why
    // the projection takes two passes.
    recorder.note("session-1", null, {
      type: "note.step.settled",
      turnId: "t1",
      stepId: "p1",
      content: stepContent(),
    });
    registry.endRun("session-1", "stream-1");

    const read = await readLedger(join(dir, "ledger.jsonl"));
    const timeline = replayLedger(read.records);

    expect(timeline.runs).toHaveLength(1);
    expect(timeline.runs[0]).toMatchObject({
      streamId: "stream-1",
      status: "done",
    });
    expect(timeline.runs[0]?.turns).toHaveLength(1);
    expect(timeline.runs[0]?.turns[0]).toMatchObject({
      turnId: "t1",
      status: "done",
    });
    expect(timeline.runs[0]?.turns[0]?.steps[0]).toMatchObject({
      stepId: "p1",
      status: "done",
      content: { id: "p1" },
    });
  });

  test("keeps a family it does not know aside instead of failing", () => {
    const unknown = {
      line: 1,
      v: 1,
      at: 1,
      epoch: "e1",
      type: "trace.something",
    } as unknown as LedgerRecord;

    const timeline = replayLedger([unknown]);

    expect(timeline.unreadable).toStrictEqual([unknown]);
    expect(timeline.runs).toStrictEqual([]);
    expect(timeline.notes).toStrictEqual([]);
  });
});
