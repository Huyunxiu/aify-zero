import type { AgentUserTurn, InboxItem } from "@workspace/agent-client";
import { InboxItemNotFoundError } from "@workspace/agent/inbox/errors";
import type {
  SessionEndStatus,
  SessionRecord,
  SessionStatus,
} from "@workspace/agent/storage/types";
import { describe, expect, test } from "vitest";

import { SessionRunner } from "../src/session/runner";
import type {
  RunnerRegistry,
  RunnerStore,
  StartedRun,
} from "../src/session/runner";

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

const inboxItem = (sessionId: string, seq: number): InboxItem => ({
  seq,
  id: `${sessionId}-item-${seq}`,
  sessionId,
  kind: "user-message",
  dedupeKey: `${sessionId}-${seq}`,
  deliverAt: "run-boundary",
  content: userTurn(`${sessionId}-turn-${seq}`),
  payload: { model: { providerId: "test-provider", modelId: "test-model" } },
  createdAt: 1,
});

const sessionRow = (
  id: string,
  overrides: Partial<SessionRecord> = {}
): SessionRecord => ({
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
  ...overrides,
});

/** 收件箱与会话行的替身：按到达顺序发，被领走就消失。 */
class FakeStore implements RunnerStore {
  readonly sessions = new Map<string, SessionRecord>();
  readonly items = new Map<string, InboxItem[]>();

  constructor(sessions: SessionRecord[] = []) {
    for (const session of sessions) {
      this.sessions.set(session.id, session);
    }
  }

  add(sessionId: string, count: number): void {
    const list = this.items.get(sessionId) ?? [];
    const start = list.length;
    for (let offset = 0; offset < count; offset += 1) {
      list.push(inboxItem(sessionId, start + offset));
    }
    this.items.set(sessionId, list);
  }

  pending(sessionId: string): InboxItem[] {
    return this.items.get(sessionId) ?? [];
  }

  claim(sessionId: string, id: string): void {
    this.items.set(
      sessionId,
      this.pending(sessionId).filter((entry) => entry.id !== id)
    );
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
    }
  }

  getSessionById(sessionId: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null);
  }

  listInboxMessages(
    sessionId: string,
    options?: { deliverAt?: InboxItem["deliverAt"] }
  ): Promise<InboxItem[]> {
    const list = this.pending(sessionId);

    return Promise.resolve(
      options?.deliverAt
        ? list.filter((entry) => entry.deliverAt === options.deliverAt)
        : [...list]
    );
  }
}

/** 注册表的替身：只有“这个会话有没有流在跑”。 */
class FakeRegistry implements RunnerRegistry {
  readonly live = new Set<string>();

  getStreamEntryBySession(
    sessionId: string
  ): { isDone(): boolean } | undefined {
    return this.live.has(sessionId) ? { isDone: () => false } : undefined;
  }
}

type Started = {
  sessionId: string;
  item: InboxItem;
  settle: (status: SessionEndStatus) => void;
};

/**
 * 起跑的替身：认领待办项，返回一个由测试决定何时落定的运行。
 *
 * `claimElsewhere` 模拟另一个调用者先领走了这一条：行已经不在了，抛错。
 */
const makeStart = (
  store: FakeStore,
  options: {
    claimElsewhere?: (call: { sessionId: string; item: InboxItem }) => boolean;
  } = {}
) => {
  const calls: { sessionId: string; item: InboxItem }[] = [];
  const started: Started[] = [];

  const startRun = (call: {
    sessionId: string;
    item: InboxItem;
  }): Promise<StartedRun> => {
    if (options.claimElsewhere?.(call)) {
      store.claim(call.sessionId, call.item.id);
      return Promise.reject(new InboxItemNotFoundError(call.item.id));
    }

    store.claim(call.sessionId, call.item.id);
    calls.push(call);

    let settleRun!: (status: SessionEndStatus) => void;
    const settled = new Promise<SessionEndStatus>((resolve) => {
      settleRun = resolve;
    });

    started.push({
      sessionId: call.sessionId,
      item: call.item,
      settle: (status) => {
        store.setStatus(call.sessionId, status === "done" ? "idle" : status);
        settleRun(status);
      },
    });

    return Promise.resolve({ settled });
  };

  return { startRun, calls, started };
};

/** 让所有排队的微任务和计时器都跑完。 */
const flush = async (): Promise<void> => {
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

const makeRunner = (input: {
  store: FakeStore;
  registry?: FakeRegistry;
  start: ReturnType<typeof makeStart>;
  maxConcurrent?: number;
}) =>
  new SessionRunner({
    store: input.store,
    registry: input.registry ?? new FakeRegistry(),
    startRun: input.start.startRun,
    resumeRun: () =>
      Promise.reject(new Error("resumeRun is not used in these tests")),
    ...(input.maxConcurrent === undefined
      ? {}
      : { maxConcurrent: input.maxConcurrent }),
    warn: () => {},
  });

describe(SessionRunner, () => {
  test("连发三条时串行三次运行，顺序与入队一致", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 3);
    const start = makeStart(store);
    const runner = makeRunner({ store, start });

    runner.wake("s1");
    await flush();

    expect(start.calls.map((call) => call.item.seq)).toStrictEqual([0]);
    expect(runner.runningSessions()).toStrictEqual(["s1"]);

    start.started[0]?.settle("done");
    await flush();
    expect(start.calls.map((call) => call.item.seq)).toStrictEqual([0, 1]);

    start.started[1]?.settle("done");
    await flush();
    expect(start.calls.map((call) => call.item.seq)).toStrictEqual([0, 1, 2]);

    start.started[2]?.settle("done");
    await flush();
    expect({
      calls: start.calls.map((call) => call.item.seq),
      running: runner.runningSessions(),
      pending: store.pending("s1"),
    }).toStrictEqual({ calls: [0, 1, 2], running: [], pending: [] });
  });

  test("一次失败后暂停，队列保留；resume 之后继续", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 2);
    const start = makeStart(store);
    const runner = makeRunner({ store, start });

    runner.wake("s1");
    await flush();
    start.started[0]?.settle("error");
    await flush();

    expect(runner.pauseReason("s1")).toBe("error");
    expect(store.pending("s1")).toHaveLength(1);

    // 暂停期间再来一次唤醒也不会自动往下跑。
    runner.wake("s1");
    await flush();
    expect(start.calls).toHaveLength(1);

    runner.wakeAfterPause("s1");
    await flush();
    expect(start.calls).toHaveLength(2);
    expect(runner.pauseReason("s1")).toBeUndefined();
  });

  test("用户停掉之后不再自动发下一条", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 2);
    const start = makeStart(store);
    const runner = makeRunner({ store, start });

    runner.wake("s1");
    await flush();
    start.started[0]?.settle("canceled");
    await flush();

    expect(runner.pauseReason("s1")).toBe("canceled");
    expect(start.calls).toHaveLength(1);
  });

  test("等待审批时停住，但不算暂停", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 2);
    const start = makeStart(store);
    const runner = makeRunner({ store, start });

    runner.wake("s1");
    await flush();
    start.started[0]?.settle("wait_review");
    await flush();

    expect(runner.pauseReason("s1")).toBeUndefined();
    runner.wake("s1");
    await flush();
    expect(start.calls).toHaveLength(1);

    // 审批回来之后，会话行离开 wait_review，下一次唤醒就能接着跑。
    store.setStatus("s1", "idle");
    runner.wake("s1");
    await flush();
    expect(start.calls).toHaveLength(2);
  });

  test("被别处领走时跳过这一条，接着取下一条", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 2);
    const start = makeStart(store, {
      claimElsewhere: ({ item }) => item.seq === 0,
    });
    const runner = makeRunner({ store, start });

    runner.wake("s1");
    await flush();

    expect(start.calls.map((call) => call.item.seq)).toStrictEqual([1]);
    expect(runner.pauseReason("s1")).toBeUndefined();
  });

  test("运行起点也领残留的 step-boundary 项", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 1);
    const [leftover] = store.pending("s1");
    if (leftover) {
      leftover.deliverAt = "step-boundary";
    }
    const start = makeStart(store);
    const runner = makeRunner({ store, start });

    runner.wake("s1");
    await flush();

    expect(start.calls.map((call) => call.item.seq)).toStrictEqual([0]);
  });

  test("子会话不跑", async () => {
    const store = new FakeStore([sessionRow("child", { kind: "subagent" })]);
    store.add("child", 1);
    const start = makeStart(store);
    const runner = makeRunner({ store, start });

    runner.wake("child");
    await flush();

    expect(start.calls).toHaveLength(0);
  });

  test("转圈时不抢：已经有流在跑的会话不动", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 1);
    const registry = new FakeRegistry();
    registry.live.add("s1");
    const start = makeStart(store);
    const runner = makeRunner({ store, registry, start });

    runner.wake("s1");
    await flush();
    expect(start.calls).toHaveLength(0);

    registry.live.delete("s1");
    runner.wake("s1");
    await flush();
    expect(start.calls).toHaveLength(1);
  });

  test("stop 之后不再取新件，正在跑的那条照样落定", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 2);
    const start = makeStart(store);
    const runner = makeRunner({ store, start });

    runner.wake("s1");
    await flush();
    expect(start.calls).toHaveLength(1);

    runner.stop();
    start.started[0]?.settle("done");
    await flush();

    expect({
      calls: start.calls.length,
      running: runner.runningSessions(),
    }).toStrictEqual({ calls: 1, running: [] });
  });

  test("state 报告正在跑、等待和暂停", async () => {
    const store = new FakeStore([sessionRow("s1"), sessionRow("s2")]);
    store.add("s1", 2);
    store.add("s2", 1);
    const start = makeStart(store);
    const runner = makeRunner({ store, start, maxConcurrent: 1 });

    runner.wake("s1");
    runner.wake("s2");
    await flush();

    expect(runner.state()).toStrictEqual({
      running: ["s1"],
      waiting: ["s2"],
      paused: [],
    });

    start.started[0]?.settle("error");
    await flush();

    expect(runner.state().paused).toStrictEqual([
      { sessionId: "s1", reason: "error" },
    ]);
  });

  test("并发上限之外的会话留到下一个名额", async () => {
    const sessions = ["s1", "s2", "s3", "s4", "s5"];
    const store = new FakeStore(sessions.map((id) => sessionRow(id)));
    const start = makeStart(store);
    for (const id of sessions) {
      store.add(id, 1);
    }
    const runner = makeRunner({ store, start, maxConcurrent: 2 });

    for (const id of sessions) {
      runner.wake(id);
    }
    await flush();

    expect(runner.runningSessions()).toHaveLength(2);
    expect(start.calls).toHaveLength(2);

    start.started[0]?.settle("done");
    await flush();

    expect(start.calls).toHaveLength(3);
  });
});
