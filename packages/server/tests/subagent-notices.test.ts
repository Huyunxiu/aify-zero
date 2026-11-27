import type { NoticeWriter } from "@workspace/agent";
import type { InboxPayload } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { reportRecoveredSubagents } from "../src/subagent-notices.js";

type Written = {
  sessionId: string;
  text: string;
  dedupeKey: string;
  form: { kind: string; source: string };
  payload?: InboxPayload;
};

/** The writer as this caller uses it: one way to write. */
const writer = () => {
  const written: Written[] = [];
  const notices = {
    write: (request: Written) => {
      written.push(request);
      return Promise.resolve();
    },
    canDeliver: () => true,
    resetBudget: () => {},
  } as unknown as NoticeWriter;

  return { notices, written };
};

type Row = {
  kind: string;
  metadata: unknown;
  parentSessionId: string | null;
  subagentName: string | null;
  lastPayload: InboxPayload | null;
};

const store = (
  rows: Record<string, Row>,
  turns: Record<string, unknown[]> = {}
) => ({
  getSessionById: (sessionId: string) => {
    const row = rows[sessionId];
    return Promise.resolve(
      row === undefined ? null : { id: sessionId, ...row }
    );
  },
  getBranchTurns: (sessionId: string) =>
    Promise.resolve((turns[sessionId] ?? []) as never[]),
});

/** A parent that ran before, so its row remembers what to wake it with. */
const parentRow = (lastPayload?: InboxPayload | null): Row => ({
  kind: "main",
  metadata: {},
  parentSessionId: null,
  subagentName: null,
  lastPayload:
    lastPayload === undefined
      ? { model: { providerId: "test", modelId: "test-model" } }
      : lastPayload,
});

const childRow = (overrides: Partial<Row> = {}): Row => ({
  kind: "subagent",
  metadata: { subagentType: "plan" },
  parentSessionId: "parent-1",
  subagentName: "AGENT-3",
  lastPayload: null,
  ...overrides,
});

/** The child's own last answer, as the recovery path reads it back. */
const announcedTurn = (text: string) => ({
  content: {
    id: "turn-1",
    type: "assistant",
    createdAt: 1,
    status: "error",
    content: [
      {
        id: "step-1",
        type: "assistant",
        createdAt: 1,
        status: "done",
        content: [{ type: "text", text, createdAt: 1, state: "done" }],
      },
    ],
  },
});

describe("the runs a previous process left behind", () => {
  test("are announced to the parent that was waiting on them", async () => {
    const { notices, written } = writer();

    await reportRecoveredSubagents({
      recovered: [{ sessionId: "child-1" }],
      store: store({ "child-1": childRow(), "parent-1": parentRow() }),
      notices,
    });

    expect(written).toHaveLength(1);
    expect(written[0]?.sessionId).toBe("parent-1");
  });

  test("carry the configuration that lets a wake-up run start", async () => {
    const { notices, written } = writer();
    const model = { providerId: "test", modelId: "test-model" };

    await reportRecoveredSubagents({
      recovered: [{ sessionId: "child-1" }],
      store: store({
        "child-1": childRow(),
        "parent-1": parentRow({ model, modelEffort: "high" }),
      }),
      notices,
    });

    // The parent never ran in this process, so the writer has no configuration
    // of its own to wake it with; the notice carries the row's.
    expect(written[0]?.payload).toStrictEqual({ model, modelEffort: "high" });
  });

  test("name the child, the form, and what settled", async () => {
    const { notices, written } = writer();

    await reportRecoveredSubagents({
      recovered: [{ sessionId: "child-1" }],
      store: store({ "child-1": childRow(), "parent-1": parentRow() }),
      notices,
    });

    expect(written[0]?.dedupeKey).toBe("subagent-settled:child-1:recovered");
    expect(written[0]?.form).toStrictEqual({
      kind: "subagent-settled",
      source: "subagent-settled",
    });
    expect(written[0]?.text).toContain(
      "subagent AGENT-3 (plan) settled: error"
    );
  });

  test("include what the child had already said", async () => {
    const { notices, written } = writer();

    await reportRecoveredSubagents({
      recovered: [{ sessionId: "child-1" }],
      store: store(
        { "child-1": childRow(), "parent-1": parentRow() },
        { "child-1": [announcedTurn("Found it in the router.")] }
      ),
      notices,
    });

    // The run did not finish, but its last answer is still evidence the parent
    // should get: without it, every recovery reads as a silent failure.
    expect(written[0]?.text).toContain("Found it in the router.");
  });

  test("are skipped, with a reason, when the parent has no configuration", async () => {
    const { notices, written } = writer();

    await reportRecoveredSubagents({
      recovered: [{ sessionId: "child-1" }],
      store: store({ "child-1": childRow(), "parent-1": parentRow(null) }),
      notices,
    });

    expect(written).toStrictEqual([]);
  });

  test("say nothing about a main session", async () => {
    const { notices, written } = writer();

    await reportRecoveredSubagents({
      recovered: [{ sessionId: "session-1" }],
      store: store({
        "session-1": parentRow(),
      }),
      notices,
    });

    expect(written).toStrictEqual([]);
  });

  test("leave the rest of the queue alone when one parent cannot be told", async () => {
    const { notices, written } = writer();

    await reportRecoveredSubagents({
      recovered: [{ sessionId: "child-1" }, { sessionId: "child-2" }],
      store: store({
        "child-1": childRow(),
        "parent-1": parentRow(null),
        "child-2": childRow({
          parentSessionId: "parent-2",
          subagentName: "AGENT-2",
        }),
        "parent-2": parentRow(),
      }),
      notices,
    });

    expect(written.map((notice) => notice.sessionId)).toStrictEqual([
      "parent-2",
    ]);
  });
});
