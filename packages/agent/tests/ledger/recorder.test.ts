import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStreamEvent, LedgerRecord } from "@workspace/agent-client";
import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import { SessionLedgerRecorder } from "../../src/ledger/recorder.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ledger-"));
}

function recordsOf(path: string): LedgerRecord[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LedgerRecord);
}

const delta = (stepId: string, text: string): AgentStreamEvent<ToolSet> =>
  ({
    type: "text.delta",
    turnId: "t1",
    stepId,
    createdAt: 1,
    id: "x1",
    text,
  }) as AgentStreamEvent<ToolSet>;

const stepFailed = (stepId: string): AgentStreamEvent<ToolSet> =>
  ({
    type: "step.finish",
    turnId: "t1",
    stepId,
    createdAt: 2,
    status: "error",
    error: "boom",
  }) as AgentStreamEvent<ToolSet>;

const stepDone = (stepId: string): AgentStreamEvent<ToolSet> =>
  ({
    type: "step.finish",
    turnId: "t1",
    stepId,
    createdAt: 2,
    status: "done",
  }) as AgentStreamEvent<ToolSet>;

describe("the session ledger recorder", () => {
  test("names the process once, however many records follow", () => {
    const dir = tempDir();
    const recorder = new SessionLedgerRecorder({
      dirOf: () => dir,
      pid: 413,
      appVersion: "0.4.1",
      now: () => 1000,
    });

    recorder.startRun("s1", "e1", "k1");
    recorder.event("s1", "e1", "k1", stepDone("p1"));
    recorder.endRun("s1", "e1", "k1");
    recorder.startRun("s1", "e2", "k2");

    const records = recordsOf(join(dir, "ledger.jsonl"));

    expect(
      records.filter((record) => record.type === "note.process")
    ).toHaveLength(1);
    expect(records.map((record) => record.type)).toStrictEqual([
      "note.process",
      "stream.run.start",
      "stream.run.event",
      "stream.run.end",
      "stream.run.start",
    ]);
    expect(records.map((record) => record.epoch)).toStrictEqual([
      "e1",
      "e1",
      "e1",
      "e1",
      "e2",
    ]);
  });

  test("keeps the typing out of the file and writes it when the step fails", () => {
    const dir = tempDir();
    const recorder = new SessionLedgerRecorder({
      dirOf: () => dir,
      pid: 413,
      appVersion: "0.4.1",
    });

    recorder.startRun("s1", "e1", "k1");
    recorder.event("s1", "e1", "k1", delta("p1", "你"));
    recorder.event("s1", "e1", "k1", delta("p1", "好"));
    recorder.event("s1", "e1", "k1", stepFailed("p1"));

    const records = recordsOf(join(dir, "ledger.jsonl"));
    const backlog = records.find(
      (record) => record.type === "note.step.delta-backlog"
    );

    expect(
      records.filter(
        (record) =>
          record.type === "stream.run.event" &&
          record.event.type === "text.delta"
      )
    ).toHaveLength(0);
    expect(backlog).toMatchObject({
      type: "note.step.delta-backlog",
      stepId: "p1",
      truncated: false,
    });
    expect(
      backlog?.type === "note.step.delta-backlog" ? backlog.chunks : []
    ).toHaveLength(2);
    expect(records.map((record) => record.type)).toStrictEqual([
      "note.process",
      "stream.run.start",
      "stream.run.event",
      "note.step.delta-backlog",
    ]);
  });

  test("throws the typing away when the step settles", () => {
    const dir = tempDir();
    const recorder = new SessionLedgerRecorder({
      dirOf: () => dir,
      pid: 413,
      appVersion: "0.4.1",
    });

    recorder.startRun("s1", "e1", "k1");
    recorder.event("s1", "e1", "k1", delta("p1", "你"));
    recorder.event("s1", "e1", "k1", stepDone("p1"));

    expect(
      recordsOf(join(dir, "ledger.jsonl")).map((record) => record.type)
    ).toStrictEqual(["note.process", "stream.run.start", "stream.run.event"]);
  });

  test("leaves a run alone when the ledger cannot be opened", () => {
    // A file where the session directory belongs, so nothing under it can be created.
    const blocker = join(tempDir(), "blocker");
    writeFileSync(blocker, "", "utf-8");

    const recorder = new SessionLedgerRecorder({
      dirOf: () => blocker,
      pid: 413,
      appVersion: "0.4.1",
    });

    expect(() => {
      recorder.startRun("s1", "e1", "k1");
      recorder.event("s1", "e1", "k1", stepDone("p1"));
      recorder.endRun("s1", "e1", "k1");
    }).not.toThrow();
    expect(recorder.failures).toBe(1);
  });
});

describe("the settings a turn ran under", () => {
  test("keeps one copy of the prompt and names its blocks", () => {
    const dir = tempDir();
    const recorder = new SessionLedgerRecorder({
      dirOf: () => dir,
      pid: 413,
      appVersion: "0.4.1",
    });

    const settings = {
      streamId: "k1",
      model: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      effort: "medium" as const,
      approvalPolicy: "edit" as const,
      instructions: {
        text: "You are a careful agent.",
        sections: [
          { id: "identity", priority: 0, text: "You are a careful agent." },
        ],
      },
    };

    recorder.turnSettings("s1", "e1", { ...settings, turnId: "t1" });
    recorder.turnSettings("s1", "e1", { ...settings, turnId: "t2" });

    const notes = recordsOf(join(dir, "ledger.jsonl")).filter(
      (record) => record.type === "note.turn.settings"
    );
    const digest = createHash("sha256")
      .update("You are a careful agent.")
      .digest("hex");

    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({
      turnId: "t1",
      model: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      effort: "medium",
      approvalPolicy: "edit",
      instructions: { sha256: digest, bytes: 24 },
      sections: [{ id: "identity", priority: 0, sha256: digest }],
    });
    expect(readdirSync(join(dir, "ledger", "blobs"))).toStrictEqual([digest]);
  });
});
