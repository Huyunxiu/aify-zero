import type {
  AgentTurn,
  AgentUserTurn,
  InboxItem,
} from "@workspace/agent-client";
import type { ModelRef } from "@workspace/shared/model";
import { describe, expect, test, vi } from "vitest";

import type { AgentSession } from "../../src/agent-session";
import type { Agent } from "../../src/agents";
import type { AgentRunnerStore } from "../../src/runtime";
import { createAgentRunner } from "../../src/runtime";
import type { SessionRecord, SessionEndStatus } from "../../src/storage";

const session = (id: string): SessionRecord => ({
  id,
  title: "",
  metadata: {},
  projectId: "p1",
  kind: "main",
  activeHeadId: null,
  activeStreamId: null,
  status: "idle",
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  parentSessionId: null,
  parentToolCallId: null,
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
    turns: AgentTurn<never>[];
    onFinish: (status: SessionEndStatus) => Promise<void>;
  }) => void = (options) => {
    void options.onFinish("done");
  }
): Agent => {
  const stream = (options: {
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
