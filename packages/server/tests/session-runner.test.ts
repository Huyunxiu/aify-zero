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
  ResumeInput,
  ResumeRun,
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

  listInboxItems(
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
  ): { isDone(): boolean; whenFinished(): Promise<void> } | undefined {
    return this.live.has(sessionId)
      ? { isDone: () => false, whenFinished: () => Promise.resolve() }
      : undefined;
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
    /** 起跑时抛一个错误：`busy` 模拟压缩抢到了锁，`fail` 模拟配置坏了。 */
    reject?: (call: {
      sessionId: string;
      item: InboxItem;
    }) => "busy" | "fail" | undefined;
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

    const rejection = options.reject?.(call);
    if (rejection === "busy") {
      const busy = new Error("SESSION_BUSY");
      Object.assign(busy, { code: "SESSION_BUSY" });
      return Promise.reject(busy);
    }
    if (rejection === "fail") {
      return Promise.reject(new Error("model not found"));
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

/** 这个会话停下来的原因；没有停下时为 undefined。 */
const pausedReason = (
  runner: SessionRunner,
  sessionId: string
): string | undefined =>
  runner.state().paused.find((entry) => entry.sessionId === sessionId)?.reason;

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
}) =>
  new SessionRunner({
    store: input.store,
    registry: input.registry ?? new FakeRegistry(),
    startRun: input.start.startRun,
    resumeRun: () =>
      Promise.reject(new Error("resumeRun is not used in these tests")),
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
    expect(runner.state().running).toStrictEqual(["s1"]);

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
      running: runner.state().running,
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

    expect(pausedReason(runner, "s1")).toBe("error");
    expect(store.pending("s1")).toHaveLength(1);

    // 暂停期间再来一次唤醒也不会自动往下跑。
    runner.wake("s1");
    await flush();
    expect(start.calls).toHaveLength(1);

    runner.wakeAfterPause("s1");
    await flush();
    expect(start.calls).toHaveLength(2);
    expect(pausedReason(runner, "s1")).toBeUndefined();
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

    expect(pausedReason(runner, "s1")).toBe("canceled");
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

    expect(pausedReason(runner, "s1")).toBeUndefined();
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
    expect(pausedReason(runner, "s1")).toBeUndefined();
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

  test("压缩抢到锁时不当失败：不算暂停，等下一次唤醒再来", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 1);
    let busy = true;
    const start = makeStart(store, {
      reject: () => (busy ? "busy" : undefined),
    });
    const runner = makeRunner({ store, start });

    runner.wake("s1");
    await flush();

    expect(runner.state().paused).toStrictEqual([]);
    expect(start.calls).toHaveLength(0);

    busy = false;
    runner.wake("s1");
    await flush();

    expect(start.calls).toHaveLength(1);
  });

  test("起不来时留下暂停原因，不再空转", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 1);
    const start = makeStart(store, { reject: () => "fail" });
    const runner = makeRunner({ store, start });

    runner.wake("s1");
    await flush();

    expect(pausedReason(runner, "s1")).toBe("error");
    expect(start.calls).toHaveLength(0);
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
      running: runner.state().running,
    }).toStrictEqual({ calls: 1, running: [] });
  });

  test("state 报告正在跑和暂停", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 2);
    const start = makeStart(store);
    const runner = makeRunner({ store, start });

    runner.wake("s1");
    await flush();

    expect(runner.state()).toStrictEqual({
      running: ["s1"],
      waiting: [],
      paused: [],
    });

    start.started[0]?.settle("error");
    await flush();

    expect(runner.state()).toStrictEqual({
      running: [],
      waiting: [],
      paused: [{ sessionId: "s1", reason: "error" }],
    });
  });
});

/**
 * 审批恢复的替身：返回一个由测试决定何时落定的运行。
 *
 * 真实的恢复会写回答复再起一次运行；运行器只关心「起没起、什么时候落定」，
 * 所以这里只造这两件事。
 */
const makeResume = () => {
  const settle: ((status: SessionEndStatus) => void)[] = [];
  let resumed = 0;

  const resumeRun: ResumeRun = () => {
    resumed += 1;
    let settleRun!: (status: SessionEndStatus) => void;
    const settled = new Promise<SessionEndStatus>((resolve) => {
      settleRun = resolve;
    });
    settle.push(settleRun);

    return Promise.resolve({
      activeStreamId: "stream-1",
      settled,
      status: "running",
    });
  };

  return {
    calls: () => resumed,
    resumeRun,
    settle: (status: SessionEndStatus) => settle.at(-1)?.(status),
  };
};

const makeResumeRunner = (input: {
  store: FakeStore;
  start: ReturnType<typeof makeStart>;
}) => {
  const resume = makeResume();

  const runner = new SessionRunner({
    store: input.store,
    registry: new FakeRegistry(),
    resumeRun: resume.resumeRun,
    startRun: input.start.startRun,
    warn: () => {},
  });

  return { resume, runner };
};

const resumeInput = (sessionId: string): ResumeInput =>
  ({
    approvals: [],
    configured: { ref: { modelId: "test-model", providerId: "test" } },
    sessionId,
  }) as unknown as ResumeInput;

describe("SessionRunner approval resume", () => {
  test("审批恢复失败后队列暂停，不再自动取件", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 1);
    const start = makeStart(store);
    const { resume, runner } = makeResumeRunner({ store, start });

    await runner.resume(resumeInput("s1"));
    expect(resume.calls()).toBe(1);

    resume.settle("error");
    await flush();

    // 失败的那条已经落定，队列里还有一条，但它没有接着跑。
    expect(pausedReason(runner, "s1")).toBe("error");
    expect(start.calls).toHaveLength(0);
  });

  test("审批恢复跑完之后队列接着取件", async () => {
    const store = new FakeStore([sessionRow("s1")]);
    store.add("s1", 1);
    const start = makeStart(store);
    const { resume, runner } = makeResumeRunner({ store, start });

    await runner.resume(resumeInput("s1"));
    resume.settle("done");
    await flush();

    expect(pausedReason(runner, "s1")).toBeUndefined();
    expect(start.calls.map((call) => call.item.seq)).toStrictEqual([0]);
  });
});
