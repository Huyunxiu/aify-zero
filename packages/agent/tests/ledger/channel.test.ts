import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStreamEvent } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

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

describe("the channel and the ledger", () => {
  test("writes the run it broadcasts, and reads it back in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const recorder = new SessionLedgerRecorder({
      dirOf: () => dir,
      pid: 413,
      appVersion: "0.4.1",
    });
    const registry = new SessionEventRegistry<AgentToolSet>(recorder);

    registry.startRun("session-1", "stream-1", { turnIds: ["u1"] });
    registry.publish("session-1", "stream-1", stepStart("p1"));
    registry.publish("session-1", "stream-1", stepDone("p1"));
    registry.endRun("session-1", "stream-1");

    const read = await readLedger(join(dir, "ledger.jsonl"));

    expect(read.records.map((record) => record.type)).toStrictEqual([
      "note.process",
      "stream.run.start",
      "stream.run.event",
      "stream.run.event",
      "stream.run.end",
    ]);
    expect(read.records[1]).toMatchObject({ turnIds: ["u1"] });

    // The reader gets the order the live stream had: what a replay rebuilds from.
    const events = read.records.flatMap((record) =>
      record.type === "stream.run.event" ? [record.event.type] : []
    );
    expect(events).toStrictEqual(["step.start", "step.finish"]);
  });
});
