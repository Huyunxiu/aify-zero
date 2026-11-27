import type { AgentRunner, SubagentSettlement } from "@workspace/agent";
import { describe, expect, test } from "vitest";

import { createSubagentNoticeAdapter } from "../src/subagent-notices.js";

type Queued = { sessionId: string; text: string; dedupeKey: string };

const settlement = (
  overrides: Partial<SubagentSettlement> = {}
): SubagentSettlement => ({
  parentSessionId: "parent-1",
  sessionId: "child-1",
  name: "AGENT-1",
  subagentType: "explore",
  status: "done",
  report: "Found the router.",
  ...overrides,
});

/** The runner as this adapter uses it: one question, one way to queue a notice. */
const runner = (deliverable = true) => {
  const queued: Queued[] = [];
  const fake = {
    canDeliverNotice: () => deliverable,
    enqueueNotice: (input: Queued) => {
      queued.push(input);
      return Promise.resolve({ id: "item-1" });
    },
  } as unknown as AgentRunner;

  return { fake, queued };
};

/** The delivery is fire-and-forget, so a test waits for the queue turn to land. */
const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

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

describe("a settled subagent", () => {
  test("leaves one notice in its parent's inbox, keyed by the child session", async () => {
    const { fake, queued } = runner();
    const adapter = createSubagentNoticeAdapter({ store: store({}) });
    adapter.bind(fake);

    adapter.deliver(settlement());
    await settle();

    expect(queued).toHaveLength(1);
    expect(queued[0]?.sessionId).toBe("parent-1");
    expect(queued[0]?.dedupeKey).toBe("subagent-settled:child-1");
    expect(queued[0]?.text).toBe(
      [
        "subagent AGENT-1 (explore) settled: done",
        "",
        "Found the router.",
      ].join("\n")
    );
  });

  test("is not queued for a session that cannot take a notice", async () => {
    const { fake, queued } = runner(false);
    const adapter = createSubagentNoticeAdapter({ store: store({}) });
    adapter.bind(fake);

    adapter.deliver(settlement());
    await settle();

    expect(queued).toStrictEqual([]);
  });

  test("is dropped, not thrown, when no runner is bound yet", () => {
    const adapter = createSubagentNoticeAdapter({ store: store({}) });

    expect(() => adapter.deliver(settlement())).not.toThrow();
  });
});

describe("a run the previous process left behind", () => {
  test("is announced to its parent, so the waiting session learns it stopped", async () => {
    const { fake, queued } = runner();
    const adapter = createSubagentNoticeAdapter({
      store: store({
        "child-1": {
          kind: "subagent",
          metadata: { subagentType: "plan" },
          parentSessionId: "parent-1",
          subagentName: "AGENT-3",
        },
      }),
    });
    adapter.bind(fake);

    await adapter.reportRecovered([{ sessionId: "child-1" }]);

    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toContain("subagent AGENT-3 (plan) settled: error");
  });

  test("says nothing about a main session", async () => {
    const { fake, queued } = runner();
    const adapter = createSubagentNoticeAdapter({
      store: store({
        "session-1": {
          kind: "main",
          metadata: {},
          parentSessionId: null,
          subagentName: null,
        },
      }),
    });
    adapter.bind(fake);

    await adapter.reportRecovered([{ sessionId: "session-1" }]);

    expect(queued).toStrictEqual([]);
  });
});
