import type { NoticeWriter } from "@workspace/agent";
import { describe, expect, test, vi } from "vitest";

import { reportRecoveredSubagents } from "../src/subagent-notices.js";

type Written = {
  sessionId: string;
  text: string;
  dedupeKey: string;
  form: { kind: string; source: string };
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

const store = (
  rows: Record<
    string,
    {
      kind: string;
      metadata: unknown;
      parentSessionId: string | null;
      subagentName: string | null;
    }
  >
) => ({
  getSessionById: (sessionId: string) => {
    const row = rows[sessionId];
    return Promise.resolve(
      row === undefined ? null : { id: sessionId, ...row }
    );
  },
});

describe("the runs a previous process left behind", () => {
  test("are announced to the parent that was waiting on them", async () => {
    const { notices, written } = writer();
    const wake = vi.fn<(sessionId: string) => void>();

    await reportRecoveredSubagents({
      recovered: [{ sessionId: "child-1" }],
      store: store({
        "child-1": {
          kind: "subagent",
          metadata: { subagentType: "plan" },
          parentSessionId: "parent-1",
          subagentName: "AGENT-3",
        },
      }),
      notices,
      wake,
    });

    // The parent has not run in this process, so it has no payload: waking it
    // first is what lets the writer accept the notice at all.
    expect(wake).toHaveBeenCalledWith("parent-1");
    expect(written).toHaveLength(1);
    expect(written[0]?.sessionId).toBe("parent-1");
  });

  test("name the child, the form, and what settled", async () => {
    const { notices, written } = writer();

    await reportRecoveredSubagents({
      recovered: [{ sessionId: "child-1" }],
      store: store({
        "child-1": {
          kind: "subagent",
          metadata: { subagentType: "plan" },
          parentSessionId: "parent-1",
          subagentName: "AGENT-3",
        },
      }),
      notices,
      wake: () => {},
    });

    expect(written[0]?.dedupeKey).toBe("subagent-settled:child-1");
    expect(written[0]?.form).toStrictEqual({
      kind: "subagent-settled",
      source: "subagent-settled",
    });
    expect(written[0]?.text).toContain(
      "subagent AGENT-3 (plan) settled: error"
    );
  });

  test("say nothing about a main session", async () => {
    const { notices, written } = writer();

    await reportRecoveredSubagents({
      recovered: [{ sessionId: "session-1" }],
      store: store({
        "session-1": {
          kind: "main",
          metadata: {},
          parentSessionId: null,
          subagentName: null,
        },
      }),
      notices,
      wake: () => {},
    });

    expect(written).toStrictEqual([]);
  });

  test("leave the rest of the queue alone when one parent cannot be woken", async () => {
    const { notices, written } = writer();
    const rows = {
      "child-1": {
        kind: "subagent",
        metadata: {},
        parentSessionId: "parent-1",
        subagentName: "AGENT-1",
      },
      "child-2": {
        kind: "subagent",
        metadata: {},
        parentSessionId: "parent-2",
        subagentName: "AGENT-2",
      },
    };

    await reportRecoveredSubagents({
      recovered: [{ sessionId: "child-1" }, { sessionId: "child-2" }],
      store: store(rows),
      notices,
      wake: (sessionId) => {
        if (sessionId === "parent-1") {
          throw new Error("gone");
        }
      },
    });

    expect(written.map((notice) => notice.sessionId)).toStrictEqual([
      "parent-2",
    ]);
  });
});
