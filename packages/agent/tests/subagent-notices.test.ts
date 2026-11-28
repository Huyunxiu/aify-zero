import type {
  AgentTurn,
  AgentUserTurn,
  EnqueueInboxInput,
  InboxItem,
  InboxPayload,
} from "@workspace/agent-client";
import { describe, expect, test, vi } from "vitest";

import type { Agent } from "../src/agents.js";
import type { AgentRunnerStore } from "../src/runtime/index.js";
import { createAgentRunner } from "../src/runtime/index.js";
import type { SessionEndStatus, SessionRecord } from "../src/storage/index.js";
import type { TurnRecord } from "../src/storage/turn-record.js";
import type { AgentToolSet } from "../src/types.js";
import { testModel } from "./helpers/model-target.js";

const session = (
  id: string,
  overrides: Partial<SessionRecord> = {}
): SessionRecord => ({
  id,
  title: "",
  metadata: {},
  botId: "default",
  projectId: null,
  kind: "main",
  activeHeadId: null,
  activeStreamId: null,
  status: "idle",
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  parentSessionId: null,
  parentToolCallId: null,
  subagentName: null,
  lastPayload: null,
  approvalPolicy: "edit",
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const parentRow = (
  id = "parent-1",
  lastPayload?: InboxPayload | null,
  overrides: Partial<SessionRecord> = {}
): SessionRecord =>
  session(id, {
    kind: "main",
    lastPayload:
      lastPayload === undefined ? { model: testModel() } : lastPayload,
    ...overrides,
  });

const childRow = (
  id = "child-1",
  overrides: Partial<SessionRecord> = {}
): SessionRecord =>
  session(id, {
    kind: "subagent",
    metadata: { subagentType: "plan" },
    parentSessionId: "parent-1",
    subagentName: "AGENT-3",
    activeStreamId: `stream-${id}`,
    status: "running",
    ...overrides,
  });

const userTurn = (id: string, text = id): AgentUserTurn => ({
  id,
  type: "user",
  createdAt: 1,
  status: "done",
  content: [
    {
      id: `${id}-step`,
      type: "user",
      createdAt: 1,
      status: "done",
      content: [{ type: "text", text, createdAt: 1 }],
    },
  ],
});

/** The child's own last answer, as the recovery path reads it back. */
const assistantTurnRecord = (
  sessionId: string,
  text: string,
  status: "done" | "error" | "streaming" = "error"
): TurnRecord => ({
  id: "turn-1",
  sessionId,
  type: "assistant",
  metadata: {},
  parentId: null,
  status,
  detail: null,
  completedAt: null,
  createdAt: new Date(1),
  updatedAt: new Date(1),
  content: {
    id: "turn-1",
    type: "assistant",
    createdAt: 1,
    status,
    content: [
      {
        id: "step-1",
        type: "assistant",
        createdAt: 1,
        status: "done",
        model: "test-model",
        content: [{ type: "text", text, createdAt: 1, state: "done" }],
      },
    ],
  } as AgentTurn<AgentToolSet>,
});

class FakeStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly items: InboxItem[] = [];
  readonly turns = new Map<string, TurnRecord[]>();
  /** When false, `listInboxItems` leaves queued rows in place for inspection. */
  claimOnRead = false;

  constructor(rows: SessionRecord[], turns: Record<string, TurnRecord[]> = {}) {
    for (const row of rows) {
      this.sessions.set(row.id, row);
    }
    for (const [sessionId, list] of Object.entries(turns)) {
      this.turns.set(sessionId, list);
    }
  }

  getSessionById(id: string) {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  findSessionRow(id: string) {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  listInterruptedSessions() {
    return Promise.resolve(
      [...this.sessions.values()].filter((row) => row.activeStreamId !== null)
    );
  }

  getBranchTurns(sessionId: string) {
    return Promise.resolve(this.turns.get(sessionId) ?? []);
  }

  updateTurn(sessionId: string, id: string, turn: AgentTurn<AgentToolSet>) {
    const list = this.turns.get(sessionId) ?? [];
    const index = list.findIndex((entry) => entry.id === id);
    if (index === -1) {
      return Promise.resolve(0);
    }
    list[index] = { ...list[index]!, content: turn };
    return Promise.resolve(1);
  }

  setActiveStream(sessionId: string, streamId: string) {
    const row = this.sessions.get(sessionId);
    if (row) {
      row.activeStreamId = streamId;
      row.status = "running";
    }
    return Promise.resolve(1);
  }

  clearActiveStream(
    sessionId: string,
    streamId: string,
    status: SessionEndStatus
  ) {
    const row = this.sessions.get(sessionId);
    if (row?.activeStreamId === streamId) {
      row.activeStreamId = null;
      row.status = status;
    }
    return Promise.resolve(1);
  }

  insertInboxItem(input: EnqueueInboxInput) {
    const existing = this.items.find(
      (entry) =>
        entry.sessionId === input.sessionId &&
        entry.dedupeKey === input.dedupeKey
    );
    if (existing) {
      return Promise.resolve(existing);
    }

    const created: InboxItem = {
      seq: this.items.length,
      id: `${input.sessionId}-item-${String(this.items.length)}`,
      sessionId: input.sessionId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      deliverAt: input.deliverAt,
      content: input.content,
      payload: input.payload,
      createdAt: 1,
    };
    this.items.push(created);
    return Promise.resolve(created);
  }

  listInboxItems(sessionId: string) {
    const list = this.items.filter((entry) => entry.sessionId === sessionId);
    if (this.claimOnRead) {
      this.items.splice(
        0,
        this.items.length,
        ...this.items.filter((entry) => entry.sessionId !== sessionId)
      );
    }
    return Promise.resolve(list);
  }

  deleteInboxItems(sessionId: string, ids?: readonly string[]) {
    const before = this.items.length;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const entry = this.items[index];
      if (entry === undefined || entry.sessionId !== sessionId) {
        continue;
      }
      if (ids === undefined || ids.includes(entry.id)) {
        this.items.splice(index, 1);
      }
    }
    return Promise.resolve(before - this.items.length);
  }

  listPendingInboxSessionIds() {
    return Promise.resolve([
      ...new Set(this.items.map((entry) => entry.sessionId)),
    ]);
  }

  listChildSessions() {
    return Promise.resolve([]);
  }

  setLastPayload() {
    return Promise.resolve(1);
  }
}

const asRunnerStore = (store: FakeStore): AgentRunnerStore =>
  store as unknown as AgentRunnerStore;

const silentBuildAgent = () => Promise.reject(new Error("must not build"));

describe("recovery notices through AgentRunner.start()", () => {
  test("announces interrupted subagent runs to the parent and wakes it", async () => {
    const store = new FakeStore([parentRow(), childRow()]);
    store.claimOnRead = true;

    const claimedCalls: {
      sessionId: string;
      model: unknown;
      effort: unknown;
      claims: readonly { inboxId: string; turn: AgentTurn<AgentToolSet> }[];
    }[] = [];

    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: (input) => {
        const agent = {
          stream: (options: {
            claims?: readonly {
              inboxId: string;
              turn: AgentTurn<AgentToolSet>;
            }[];
            onFinish: (status: SessionEndStatus) => Promise<void>;
          }) => {
            claimedCalls.push({
              sessionId: input.sessionId,
              model: input.model,
              effort: input.effort,
              claims: options.claims ?? [],
            });
            void options.onFinish("done");
            return Promise.resolve(
              new ReadableStream({
                start(controller) {
                  controller.close();
                },
              })
            );
          },
          dispose: () => Promise.resolve(),
        } as unknown as Agent;
        return Promise.resolve(agent);
      },
      logger: { warn: () => {} },
    });

    const report = await runner.start();

    expect(report.recovered).toStrictEqual([{ sessionId: "child-1" }]);
    await vi.waitFor(() => {
      expect(claimedCalls).toHaveLength(1);
    });
    expect(claimedCalls[0]?.sessionId).toBe("parent-1");
    expect(claimedCalls[0]?.claims).toHaveLength(1);

    await runner.shutdown();
  });

  test("carries the parent's stored payload so a wake-up run keeps model and effort", async () => {
    const model = { providerId: "test", modelId: "test-model" };
    const store = new FakeStore([
      parentRow(
        "parent-1",
        { model, modelEffort: "high", projectId: "p1" },
        {
          status: "wait_review",
        }
      ),
      childRow(),
    ]);
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: silentBuildAgent,
      logger: { warn: () => {} },
    });

    await runner.start();

    expect(store.items).toHaveLength(1);
    expect(store.items[0]?.payload).toStrictEqual({
      model,
      modelEffort: "high",
      projectId: "p1",
    });

    await runner.shutdown();
  });

  test("names the child, the form, and what settled", async () => {
    const store = new FakeStore([
      parentRow("parent-1", { model: testModel() }, { status: "wait_review" }),
      childRow(),
    ]);
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: silentBuildAgent,
      logger: { warn: () => {} },
    });

    await runner.start();

    expect(store.items).toHaveLength(1);
    expect(store.items[0]?.dedupeKey).toBe(
      "subagent-settled:child-1:recovered"
    );
    expect(store.items[0]?.kind).toBe("subagent-settled");
    expect(store.items[0]?.content.content[0]?.source).toBe("subagent-settled");
    expect(store.items[0]?.content.content[0]?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("subagent AGENT-3 (plan) settled: error"),
    });

    await runner.shutdown();
  });

  test("includes what the child had already said", async () => {
    const store = new FakeStore(
      [
        parentRow(
          "parent-1",
          { model: testModel() },
          { status: "wait_review" }
        ),
        childRow(),
      ],
      {
        "child-1": [
          assistantTurnRecord("child-1", "Found it in the router.", "done"),
        ],
      }
    );
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: silentBuildAgent,
      logger: { warn: () => {} },
    });

    await runner.start();

    expect(store.items[0]?.content.content[0]?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Found it in the router."),
    });
    expect(store.items[0]?.content.content[0]?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("settled: done"),
    });

    await runner.shutdown();
  });

  test("runs after dropping stale notices so fresh recovery notices survive", async () => {
    const store = new FakeStore([
      parentRow("parent-1", { model: testModel() }, { status: "wait_review" }),
      childRow(),
    ]);
    // Pre-seed stale notices left behind by the previous process.
    store.items.push(
      {
        seq: 0,
        id: "stale-job",
        sessionId: "parent-1",
        kind: "job-notice",
        dedupeKey: "job-notice:old-job",
        deliverAt: "run-boundary",
        content: userTurn("turn-stale-job"),
        payload: { model: testModel() },
        createdAt: 1,
      },
      {
        seq: 1,
        id: "stale-subagent",
        sessionId: "parent-1",
        kind: "subagent-settled",
        dedupeKey: "subagent-settled:old-child:turn-1",
        deliverAt: "run-boundary",
        content: userTurn("turn-stale-subagent"),
        payload: { model: testModel() },
        createdAt: 1,
      }
    );

    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: silentBuildAgent,
      logger: { warn: () => {} },
    });

    await runner.start();

    expect(store.items.map((item) => item.dedupeKey)).toStrictEqual([
      "subagent-settled:child-1:recovered",
    ]);

    await runner.shutdown();
  });

  test("skips with a warning when the parent has no stored payload", async () => {
    const warnings: string[] = [];
    const store = new FakeStore([parentRow("parent-1", null), childRow()]);
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: silentBuildAgent,
      logger: {
        warn: (message) => {
          warnings.push(message);
        },
      },
    });

    await runner.start();

    expect(store.items).toStrictEqual([]);
    expect(
      warnings.some((message) => message.includes("has no model to wake with"))
    ).toBeTruthy();

    await runner.shutdown();
  });

  test("says nothing about an interrupted main session", async () => {
    const store = new FakeStore([
      parentRow(
        "session-1",
        { model: testModel() },
        {
          activeStreamId: "stream-main",
          status: "running",
        }
      ),
    ]);
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: silentBuildAgent,
      logger: { warn: () => {} },
    });

    const report = await runner.start();

    expect(report.recovered).toStrictEqual([{ sessionId: "session-1" }]);
    expect(store.items).toStrictEqual([]);

    await runner.shutdown();
  });

  test("leaves the rest of the queue alone when one parent cannot be told", async () => {
    const store = new FakeStore([
      parentRow("parent-1", null),
      childRow("child-1", { parentSessionId: "parent-1" }),
      parentRow("parent-2", { model: testModel() }, { status: "wait_review" }),
      childRow("child-2", {
        parentSessionId: "parent-2",
        subagentName: "AGENT-2",
      }),
    ]);
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: silentBuildAgent,
      logger: { warn: () => {} },
    });

    await runner.start();

    expect(store.items.map((item) => item.sessionId)).toStrictEqual([
      "parent-2",
    ]);

    await runner.shutdown();
  });

  test("captures recovery notice errors into startup.failures without blocking startup", async () => {
    const store = new FakeStore([
      parentRow("parent-1", { model: testModel() }),
      childRow("child-1"),
      session("queued-main"),
    ]);
    store.items.push({
      seq: 0,
      id: "user-item-1",
      sessionId: "queued-main",
      kind: "user-message",
      dedupeKey: "msg-1",
      deliverAt: "run-boundary",
      content: userTurn("turn-user"),
      payload: { model: testModel() },
      createdAt: 1,
    });

    const originalGetBranchTurns = store.getBranchTurns.bind(store);
    let readCount = 0;
    store.getBranchTurns = (sessionId: string) => {
      // First read happens in recoverInterruptedRuns; second happens in reportRecovered.
      if (sessionId === "child-1") {
        readCount += 1;
        if (readCount === 2) {
          return Promise.reject(new Error("branch read failed"));
        }
      }
      return originalGetBranchTurns(sessionId);
    };

    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: silentBuildAgent,
      logger: { warn: () => {} },
    });

    const report = await runner.start();

    expect(report.failures).toStrictEqual([{ error: "branch read failed" }]);
    expect(report.woken).toStrictEqual(["queued-main"]);

    await runner.shutdown();
  });
});
