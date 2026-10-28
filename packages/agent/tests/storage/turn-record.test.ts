import type { AgentTurn } from "@workspace/agent-client";
import type { StepModel, TurnModel } from "@workspace/db";
import { describe, expect, test } from "vitest";

import {
  hydrateTurn,
  toStepRows,
  toTurnRow,
} from "../../src/storage/turn-record.js";
import type { AgentToolSet } from "../../src/types.js";
import { assistantStep, assistantTurn } from "../compaction/fixtures.js";

const { usage } = assistantStep("usage-step", { inputTokens: 7 });

const write = (turn: AgentTurn<AgentToolSet>) => ({
  id: turn.id,
  sessionId: "session-1",
  type: turn.type,
  metadata: {},
  parentId: null,
  createdAt: new Date(100),
  content: turn,
});

const stepRow = (
  id: string,
  seq: number,
  options: { streamId?: string | null; status?: StepModel["status"] } = {}
): StepModel => ({
  id,
  turnId: "a1",
  sessionId: "session-1",
  seq,
  streamId: options.streamId ?? null,
  type: "assistant",
  status: options.status ?? "done",
  content: assistantStep(id, { text: id }),
  createdAt: new Date(1),
  updatedAt: new Date(2),
});

const turnRow = (overrides: Partial<TurnModel> = {}): TurnModel => ({
  id: "a1",
  sessionId: "session-1",
  type: "assistant",
  metadata: {},
  parentId: null,
  status: "done",
  detail: { usage },
  completedAt: new Date(200),
  createdAt: new Date(100),
  updatedAt: new Date(300),
  ...overrides,
});

describe(toTurnRow, () => {
  test("derives status, detail and completedAt from the turn", () => {
    const turn = {
      ...assistantTurn("a1", [assistantStep("s1", { text: "done" })]),
      status: "error" as const,
      error: "boom",
      completedAt: 123,
      usage,
    } as AgentTurn<AgentToolSet>;

    const row = toTurnRow(write(turn));

    expect(row.id).toBe("a1");
    expect(row.status).toBe("error");
    expect(row.completedAt?.getTime()).toBe(123);
    expect(row.detail).toMatchObject({ error: "boom", usage });
  });

  test("omits absent detail fields instead of writing null", () => {
    const row = toTurnRow(
      write(assistantTurn("a1", [assistantStep("s1", { text: "hi" })]))
    );

    expect(row.status).toBe("done");
    expect(row.completedAt).toBeNull();
    expect(row.detail).toStrictEqual({});
  });
});

describe(toStepRows, () => {
  test("maps each step to its seq and keeps the step json", () => {
    const turn = assistantTurn("a1", [
      assistantStep("s0", { text: "first" }),
      assistantStep("s1", { text: "second" }),
    ]);

    const rows = toStepRows({
      turnId: turn.id,
      sessionId: "session-1",
      content: turn,
      streamId: "stream-1",
    });

    expect(rows.map((row) => row.seq)).toStrictEqual([0, 1]);
    expect(rows.map((row) => row.id)).toStrictEqual(["s0", "s1"]);
    expect(rows[0]).toMatchObject({
      turnId: "a1",
      sessionId: "session-1",
      streamId: "stream-1",
      type: "assistant",
      status: "done",
    });
    expect(rows[0]?.content).toBe(turn.content[0]);
  });

  test("uses null streamId for non-streaming writes", () => {
    const rows = toStepRows({
      turnId: "a1",
      sessionId: "session-1",
      content: assistantTurn("a1", [assistantStep("s0")]),
    });

    expect(rows[0]?.streamId).toBeNull();
  });
});

describe(hydrateTurn, () => {
  test("orders steps by seq and maps turn-level fields", () => {
    const record = hydrateTurn(turnRow(), [stepRow("s1", 1), stepRow("s0", 0)]);

    expect(record.content.status).toBe("done");
    expect(record.content.createdAt).toBe(100);
    expect(record.content.completedAt).toBe(200);
    expect(record.content.usage).toStrictEqual(usage);
    expect(record.content.content.map((step) => step.id)).toStrictEqual([
      "s0",
      "s1",
    ]);
  });

  test("hides only the current run's steps on a streaming turn", () => {
    const record = hydrateTurn(
      turnRow({ status: "streaming" }),
      [
        stepRow("old", 0, { streamId: "stream-1" }),
        stepRow("current", 1, { streamId: "stream-2" }),
      ],
      "stream-2"
    );

    expect(record.content.content.map((step) => step.id)).toStrictEqual([
      "old",
    ]);
  });

  test("shows every step once the turn is settled", () => {
    const record = hydrateTurn(
      turnRow({ status: "done" }),
      [
        stepRow("old", 0, { streamId: "stream-1" }),
        stepRow("current", 1, { streamId: "stream-2" }),
      ],
      "stream-2"
    );

    expect(record.content.content.map((step) => step.id)).toStrictEqual([
      "old",
      "current",
    ]);
  });

  test("drops null detail values from the legacy json migration", () => {
    const record = hydrateTurn(
      turnRow({ detail: { usage: null, error: null, finishReason: "stop" } }),
      []
    );

    expect(record.content).not.toHaveProperty("usage");
    expect(record.content).not.toHaveProperty("error");
    expect(record.content.finishReason).toBe("stop");
  });
});
