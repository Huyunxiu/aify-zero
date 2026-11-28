import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentTurn,
  AgentUserTurn,
  InboxItem,
  LedgerRecord,
} from "@workspace/agent-client";
import type { ModelRef } from "@workspace/shared/model";
import { describe, expect, test, vi } from "vitest";

import type { AgentSession } from "../../src/agent-session";
import type { Agent } from "../../src/agents";
import { SessionLedgerRecorder } from "../../src/ledger/recorder";
import type { AgentRunnerStore } from "../../src/runtime";
import { createAgentRunner } from "../../src/runtime";
import type { SessionRecord, SessionEndStatus } from "../../src/storage";

const session = (id: string): SessionRecord => ({
  id,
  title: "",
  metadata: {},
  botId: "default",
  projectId: "p1",
  kind: "main",
  activeHeadId: null,
  activeStreamId: null,
  status: "idle",
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  parentSessionId: null,
  parentToolCallId: null,
  approvalPolicy: "edit",
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const userTurn = (id: string): AgentUserTurn => ({
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
      content: [{ type: "text", text: id, createdAt: 1 }],
    },
  ],
});

/**
 * 收件箱与会话行的最小替身。
 *
 * 真实 store 在写 turn 的事务里删掉待办项；这里没有 turn 写入，所以成功路径
 * 在读取时就把行交出去，模拟“领取之后不再排队”。
 */
class FakeStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly items: InboxItem[] = [];
  readonly cleared: { sessionId: string; streamId: string; status: string }[] =
    [];
  readonly interrupted: SessionRecord[] = [];
  /** 成功路径在读取时就把行交出去，模拟真实 store 在写 turn 时删除。 */
  claimOnRead = true;

  constructor(sessions: SessionRecord[] = []) {
    for (const entry of sessions) {
      this.sessions.set(entry.id, entry);
    }
  }

  getSessionById(id: string) {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  findSessionRow(id: string) {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  saveSession(write: Partial<SessionRecord> & { id: string }) {
    if (!this.sessions.has(write.id)) {
      this.sessions.set(write.id, session(write.id));
    }
    return Promise.resolve(true);
  }

  insertInboxItem(input: {
    sessionId: string;
    kind: InboxItem["kind"];
    dedupeKey: string;
    deliverAt: InboxItem["deliverAt"];
    content: AgentUserTurn;
    payload: InboxItem["payload"];
  }) {
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
      // 成功路径模拟 upsert turn 时删掉待办项。
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

  listInterruptedSessions() {
    return Promise.resolve(this.interrupted);
  }

  getBranchTurns() {
    return Promise.resolve([]);
  }

  setActiveStream(sessionId: string, streamId: string) {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.activeStreamId = streamId;
    }
    return Promise.resolve(1);
  }

  clearActiveStream(
    sessionId: string,
    streamId: string,
    status: SessionEndStatus
  ) {
    this.cleared.push({ sessionId, streamId, status });
    const entry = this.sessions.get(sessionId);
    if (entry?.activeStreamId === streamId) {
      entry.activeStreamId = null;
    }
    return Promise.resolve(1);
  }

  listChildSessions() {
    return Promise.resolve([]);
  }

  updateTurn() {
    return Promise.resolve(0);
  }
}

const asRunnerStore = (store: FakeStore): AgentRunnerStore =>
  store as unknown as AgentRunnerStore;

const model: ModelRef = { providerId: "test", modelId: "test-model" };

const fakeAgent = (
  onStream: (options: {
    claims?: readonly { inboxId: string; turn: AgentTurn<never> }[];
    turns: AgentTurn<never>[];
    onFinish: (status: SessionEndStatus) => Promise<void>;
  }) => void = (options) => {
    void options.onFinish("done");
  }
): Agent => {
  const stream = (options: {
    claims?: readonly { inboxId: string; turn: AgentTurn<never> }[];
    turns: AgentTurn<never>[];
    onFinish: (status: SessionEndStatus) => Promise<void>;
  }) => {
    onStream(options);
    return Promise.resolve(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      })
    );
  };

  return {
    stream,
    dispose: () => Promise.resolve(),
  } as unknown as Agent;
};

const fakeBuildAgent = (agent: Agent) => {
  const calls: { sessionId: string; session: AgentSession }[] = [];

  return {
    calls,
    build: (input: { sessionId: string; session: AgentSession }) => {
      calls.push(input);
      return Promise.resolve(agent);
    },
  };
};

describe("AgentRunner", () => {
  test("enqueue 起一次运行，落定后队列清空", async () => {
    const store = new FakeStore([session("s1")]);
    const agent = fakeAgent();
    const builder = fakeBuildAgent(agent);
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: builder.build,
    });

    await runner.createSession({ sessionId: "s1" });
    await runner.enqueue({
      sessionId: "s1",
      turn: userTurn("turn-1"),
      model,
    });

    await vi.waitFor(() => {
      expect(builder.calls).toHaveLength(1);
      expect(runner.state().running).toHaveLength(0);
    });
    expect(store.cleared).toHaveLength(1);
    expect(store.cleared[0]?.status).toBe("done");

    await runner.shutdown();
  });

  test("enqueueNotice 在空闲会话开一次运行，并把通知标成 job-notice", async () => {
    const store = new FakeStore([session("s1")]);
    const builder = fakeBuildAgent(fakeAgent());
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: builder.build,
    });

    await runner.createSession({ sessionId: "s1" });
    await runner.enqueue({ sessionId: "s1", turn: userTurn("turn-1"), model });
    await vi.waitFor(() => {
      expect(builder.calls).toHaveLength(1);
      expect(runner.state().running).toHaveLength(0);
    });

    const item = await runner.enqueueNotice({
      sessionId: "s1",
      text: "background job bash-1 finished",
      dedupeKey: "job-notice:bash-1",
    });

    expect(item?.kind).toBe("job-notice");
    expect(item?.deliverAt).toBe("run-boundary");
    expect(item?.content.content[0]?.source).toBe("job-notice");

    await vi.waitFor(() => expect(builder.calls).toHaveLength(2));
    await runner.shutdown();
  });

  test("canDeliverNotice 只在会话有模型配置时为真", async () => {
    const store = new FakeStore([session("s1")]);
    const builder = fakeBuildAgent(fakeAgent());
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: builder.build,
    });

    await runner.createSession({ sessionId: "s1" });
    expect(runner.canDeliverNotice("s1")).toBeFalsy();

    await runner.enqueue({ sessionId: "s1", turn: userTurn("turn-1"), model });
    expect(runner.canDeliverNotice("s1")).toBeTruthy();

    await vi.waitFor(() => {
      expect(builder.calls).toHaveLength(1);
      expect(runner.state().running).toHaveLength(0);
    });
    await runner.shutdown();
  });

  test("enqueueNotice 在没有模型配置时只记日志", async () => {
    const store = new FakeStore([session("s1")]);
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: () => Promise.reject(new Error("must not build")),
      logger: { warn: () => {} },
    });

    await runner.createSession({ sessionId: "s1" });
    const item = await runner.enqueueNotice({
      sessionId: "s1",
      text: "background job bash-1 finished",
      dedupeKey: "job-notice:bash-1",
    });

    expect(item).toBeUndefined();
    await runner.shutdown();
  });

  test("start 丢掉上一个进程留下的完成通知", async () => {
    const store = new FakeStore([session("s1")]);
    store.claimOnRead = false;
    store.items.push({
      seq: 0,
      id: "notice-1",
      sessionId: "s1",
      kind: "job-notice",
      dedupeKey: "job-notice:bash-1",
      deliverAt: "run-boundary",
      content: userTurn("turn-1"),
      payload: { model },
      createdAt: 1,
    });
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: () => Promise.reject(new Error("must not build")),
      logger: { warn: () => {} },
    });

    const report = await runner.start();

    expect(store.items).toStrictEqual([]);
    expect(report.woken).toStrictEqual([]);
  });

  test("start 留下定时器投的待办项，并唤醒会话", async () => {
    const store = new FakeStore([session("s1")]);
    store.claimOnRead = false;
    store.items.push({
      seq: 0,
      id: "timer-item-1",
      sessionId: "s1",
      kind: "timer",
      dedupeKey: "timer:timer-1",
      deliverAt: "run-boundary",
      content: userTurn("turn-1"),
      payload: { model },
      createdAt: 1,
    });
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: () => Promise.reject(new Error("must not build")),
      logger: { warn: () => {} },
    });

    const report = await runner.start();

    // 完成通知指向的任务活不过进程，定时器不是：它到点了就该被领走。
    expect(store.items.map((item) => item.id)).toStrictEqual(["timer-item-1"]);
    expect(report.woken).toStrictEqual(["s1"]);

    await runner.shutdown();
  });

  test("一次运行领走队列里的全部待办项", async () => {
    const store = new FakeStore([session("s1")]);
    const seen: AgentTurn<never>[][] = [];
    const agent = fakeAgent((options) => {
      seen.push([
        ...options.turns,
        ...(options.claims ?? []).map((claim) => claim.turn),
      ]);
      void options.onFinish("done");
    });
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: fakeBuildAgent(agent).build,
    });

    await runner.createSession({ sessionId: "s1" });
    // 三条都在运行器醒来之前到齐：一次运行应当把它们一起领走。
    for (const id of ["t1", "t2", "t3"]) {
      await store.insertInboxItem({
        sessionId: "s1",
        kind: "user-message",
        dedupeKey: id,
        deliverAt: "run-boundary",
        content: userTurn(id),
        payload: { model },
      });
    }
    runner.wake("s1");

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.map((turn) => turn.id)).toStrictEqual(["t1", "t2", "t3"]);
    expect(store.items).toHaveLength(0);

    await runner.shutdown();
  });

  test("起不来时暂停，并保留待办项", async () => {
    const store = new FakeStore([session("s1")]);
    store.claimOnRead = false;
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: () => Promise.reject(new Error("model is not configured")),
      logger: { warn: () => {} },
    });

    await runner.createSession({ sessionId: "s1" });
    await runner.enqueue({
      sessionId: "s1",
      turn: userTurn("turn-1"),
      model,
    });

    await vi.waitFor(() => {
      expect(runner.state().paused).toStrictEqual([
        { sessionId: "s1", reason: "error" },
      ]);
    });
    expect(store.items).toHaveLength(1);

    await runner.shutdown();
  });

  test("start 收尾上一个进程留下的运行", async () => {
    const store = new FakeStore([session("s1")]);
    const interrupted = session("s1");
    interrupted.activeStreamId = "stream-1";
    store.sessions.set("s1", interrupted);
    store.interrupted.push(interrupted);
    store.getBranchTurns = () =>
      Promise.resolve([
        {
          id: "turn-1",
          sessionId: "s1",
          type: "assistant",
          metadata: {},
          parentId: null,
          status: "streaming",
          detail: {},
          completedAt: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          content: {
            id: "turn-1",
            type: "assistant",
            createdAt: 1,
            status: "streaming",
            content: [],
          },
        },
      ] as never);

    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: () => Promise.reject(new Error("must not build")),
    });

    const report = await runner.start();

    expect(report.recovered).toHaveLength(1);
    expect(report.failures).toStrictEqual([]);
    expect(store.cleared).toHaveLength(1);
  });

  test("两个实例的注册表互不干扰", async () => {
    const storeA = new FakeStore([session("sa")]);
    const storeB = new FakeStore([session("sb")]);
    const builderA = fakeBuildAgent(fakeAgent());
    const builderB = fakeBuildAgent(fakeAgent());
    const runnerA = createAgentRunner({
      store: asRunnerStore(storeA),
      buildAgent: builderA.build,
    });
    const runnerB = createAgentRunner({
      store: asRunnerStore(storeB),
      buildAgent: builderB.build,
    });

    await runnerA.enqueue({
      sessionId: "sa",
      turn: userTurn("turn-a"),
      model,
    });

    await vi.waitFor(() => expect(builderA.calls).toHaveLength(1));
    expect(builderB.calls).toHaveLength(0);
    expect(runnerB.state().running).toHaveLength(0);

    await runnerA.shutdown();
    await runnerB.shutdown();
  });
});

describe("AgentRunner pause semantics", () => {
  test("wake 不清暂停，wakeAfterPause 才清", async () => {
    const store = new FakeStore([session("s1")]);
    store.claimOnRead = false;
    let attempts = 0;
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("model is not configured"))
          : Promise.resolve(fakeAgent());
      },
      logger: { warn: () => {} },
    });

    await runner.enqueue({
      sessionId: "s1",
      turn: userTurn("turn-1"),
      model,
    });

    await vi.waitFor(() => {
      expect(runner.state().paused).toStrictEqual([
        { sessionId: "s1", reason: "error" },
      ]);
    });

    runner.wake("s1");
    await vi.waitFor(() => {
      expect(runner.state().paused).toHaveLength(1);
    });
    expect(attempts).toBe(1);

    store.claimOnRead = true;
    runner.wakeAfterPause("s1");
    await vi.waitFor(() => {
      expect(attempts).toBe(2);
      expect(runner.state().paused).toStrictEqual([]);
    });

    await runner.shutdown();
  });

  test("stop 清掉残留的 activeStreamId", async () => {
    const store = new FakeStore([session("s1")]);
    store.sessions.get("s1")!.activeStreamId = "old-stream";
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: () => Promise.reject(new Error("must not build")),
    });

    await expect(runner.stop("s1")).resolves.toStrictEqual({ aborted: false });
    expect(store.cleared).toStrictEqual([
      { sessionId: "s1", streamId: "old-stream", status: "canceled" },
    ]);
  });
});

describe("AgentRunner wait_review", () => {
  test("等待审批时不暂停，也不继续取件", async () => {
    const store = new FakeStore([session("s1")]);
    store.claimOnRead = false;
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: () =>
        Promise.resolve(
          fakeAgent((options) => {
            void options.onFinish("wait_review");
          })
        ),
    });

    await runner.enqueue({
      sessionId: "s1",
      turn: userTurn("turn-1"),
      model,
    });

    await vi.waitFor(() => {
      expect(runner.state().running).toHaveLength(0);
    });
    expect(runner.state().paused).toStrictEqual([]);
    expect(store.items).toHaveLength(1);

    await runner.shutdown();
  });
});

describe("the ledger of the inbox", () => {
  test("records what arrived", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const store = new FakeStore([session("s1")]);
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: fakeBuildAgent(fakeAgent()).build,
      ledger: new SessionLedgerRecorder({
        dirOf: () => dir,
        pid: 413,
        appVersion: "0.4.1",
      }),
    });

    await runner.createSession({ sessionId: "s1" });
    await runner.enqueue({
      sessionId: "s1",
      turn: userTurn("turn-1"),
      model,
      mode: "followup",
    });

    const arrived = records(dir).filter(
      (record) => record.type === "note.inbox.arrived"
    );

    expect(arrived).toHaveLength(1);
    expect(arrived[0]).toMatchObject({
      inboxKind: "user-message",
      dedupeKey: "turn-1",
      deliverAt: "run-boundary",
    });
  });

  test("records what a person removed before it ran", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    // Straight into the queue, not through enqueue: this case is about the cancel only.
    const store = new FakeStore([session("s1")]);
    // A read is not a claim here: no run is coming, so the item stays for a person to withdraw.
    store.claimOnRead = false;
    const item = await store.insertInboxItem({
      sessionId: "s1",
      kind: "user-message",
      dedupeKey: "turn-9",
      deliverAt: "run-boundary",
      content: userTurn("turn-9"),
      payload: { model },
    });
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: fakeBuildAgent(fakeAgent()).build,
      ledger: new SessionLedgerRecorder({
        dirOf: () => dir,
        pid: 413,
        appVersion: "0.4.1",
      }),
    });

    await expect(runner.cancelInbox("s1", [item.id])).resolves.toBe(1);

    const discarded = records(dir).filter(
      (record) => record.type === "note.inbox.discarded"
    );

    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({ inboxItemId: item.id });
  });
});

describe("the ledger in the runner state", () => {
  test("reports a write that never landed", async () => {
    const blocked = join(mkdtempSync(join(tmpdir(), "ledger-")), "blocked");
    writeFileSync(blocked, "", "utf-8");
    const store = new FakeStore([session("s1")]);
    const runner = createAgentRunner({
      store: asRunnerStore(store),
      buildAgent: fakeBuildAgent(fakeAgent()).build,
      ledger: new SessionLedgerRecorder({
        // A file where the session directory belongs, so nothing under it can be created.
        dirOf: () => blocked,
        pid: 413,
        appVersion: "0.4.1",
      }),
    });

    await runner.createSession({ sessionId: "s1" });
    await runner.enqueue({
      sessionId: "s1",
      turn: userTurn("turn-1"),
      model,
      mode: "followup",
    });

    expect(runner.state().ledgerFailures).toBe(1);
  });
});

function records(dir: string): LedgerRecord[] {
  return readFileSync(join(dir, "ledger.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LedgerRecord);
}
