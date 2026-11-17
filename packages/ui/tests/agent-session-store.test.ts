import type {
  AgentStreamEvent,
  AgentUserTurn,
  InboxItem,
  SessionStreamEvent,
} from "@workspace/agent-client";
import { describe, expect, test, vi } from "vitest";

import { createAgentSessionStore } from "../src/hooks/use-agent-session";
import type { InboxApi } from "../src/hooks/use-agent-session";

/** 测试里到处用的模型引用。 */
const TEST_MODEL = { providerId: "test", modelId: "test-model" };

const userTurn = (id: string, text: string): AgentUserTurn => ({
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

const inboxMessage = (
  id: string,
  seq: number,
  content: AgentUserTurn,
  deliverAt: "step-boundary" | "run-boundary" = "run-boundary"
): InboxItem => ({
  seq,
  id,
  sessionId: "session-1",
  kind: "user-message",
  dedupeKey: `request-${id}`,
  deliverAt,
  content,
  payload: { model: TEST_MODEL },
  createdAt: 1,
});

/**
 * 会话事件流的测试替身。
 *
 * 服务端在一次运行开始时说它领走了哪几条 user 回合（`turnIds`），这里照做：
 * 测试用它模拟「排队的那条轮到了」。
 */
const sessionEvents = () => {
  let controller!: ReadableStreamDefaultController<unknown>;

  const stream = new ReadableStream({
    start(controllerArg) {
      controller = controllerArg;
    },
  });

  return {
    close: () => controller.close(),
    runEnd: (streamId: string, seq: number) =>
      controller.enqueue({ seq, streamId, type: "run.end" }),
    runEvent: (streamId: string, seq: number, event: AgentStreamEvent<never>) =>
      controller.enqueue({ event, seq, streamId, type: "run.event" }),
    runStart: (streamId: string, seq: number, turnIds?: readonly string[]) =>
      controller.enqueue({
        seq,
        streamId,
        type: "run.start",
        ...(turnIds === undefined ? {} : { turnIds }),
      }),
    send: (event: SessionStreamEvent<never>) => controller.enqueue(event),
    stream,
  };
};

const createInbox = (seed: InboxItem[] = []) => {
  let messages = [...seed];

  const api: InboxApi = {
    list: vi.fn<InboxApi["list"]>(() => Promise.resolve([...messages])),
    enqueue: vi.fn<InboxApi["enqueue"]>((input) => {
      const message = inboxMessage(
        input.dedupeKey,
        messages.length,
        input.turn,
        input.mode === "steering" ? "step-boundary" : "run-boundary"
      );
      messages = [...messages, message];
      return Promise.resolve({ item: message });
    }),
    cancel: vi.fn<InboxApi["cancel"]>((input) => {
      messages = messages.filter((message) => message.id !== input.itemId);
      return Promise.resolve({ removed: 1 });
    }),
    clear: vi.fn<InboxApi["clear"]>(() => {
      messages = [];
      return Promise.resolve({ removed: 1 });
    }),
  };

  return {
    api,
    getMessages: () => messages,
    // 模拟服务端在认领时删除 Inbox 行；没有这一步，list 会一直把它发回来。
    claim: (messageId: string) => {
      messages = messages.filter((message) => message.id !== messageId);
    },
  };
};

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const storeOf = (input: {
  apiInbox: InboxApi;
  apiSend: (options: Record<string, unknown>) => Promise<unknown>;
  apiEvents?: () => Promise<ReadableStream>;
  apiResume?: (options: { sessionId: string }) => Promise<unknown>;
  apiStop?: () => Promise<unknown>;
}) =>
  createAgentSessionStore({
    id: "session-1",
    apiInbox: input.apiInbox,
    apiSend: input.apiSend as never,
    ...(input.apiEvents === undefined ? {} : { apiEvents: input.apiEvents }),
    ...(input.apiResume === undefined ? {} : { apiResume: input.apiResume }),
    ...(input.apiStop === undefined ? {} : { apiStop: input.apiStop }),
    turns: [],
    emit: () => {
      // The store only forwards stream events; the assertions read its state.
    },
  });

describe("createAgentSessionStore queue", () => {
  test("a new session sends directly and resolves once the server accepted it", async () => {
    const calls: Record<string, unknown>[] = [];
    const store = createAgentSessionStore({
      id: "session-1",
      turns: [],
      apiSend: (options) => {
        calls.push(options);
        return Promise.resolve();
      },
      emit: () => {
        // no-op
      },
    });

    await store.submit({
      turn: userTurn("u1", "Hello"),
      payload: { model: TEST_MODEL },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.turns).toHaveLength(1);
    // 服务端收下了，但这一次运行还没开始：状态不能停在「发送中」。
    expect(store.getStatus()).toBe("ready");
  });

  test("a queued message leaves the queue when the server starts its run", async () => {
    const events = sessionEvents();
    const inbox = createInbox();
    const store = storeOf({
      apiInbox: inbox.api,
      apiEvents: () => Promise.resolve(events.stream),
      apiSend: () => Promise.resolve(),
    });

    // 第一条消息没有会话行可挂，直接发送；它的运行开始后，记录里有了回合。
    await store.submit({
      turn: userTurn("u1", "Start"),
      payload: { model: TEST_MODEL },
    });
    await flush();

    events.runStart("run-1", 1, ["u1"]);
    events.runEvent("run-1", 2, {
      type: "turn.start",
      turnId: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });

    await vi.waitFor(() => expect(store.getStatus()).toBe("streaming"));

    // 运行中的第二条进队列。
    await store.submit({
      turn: userTurn("u2", "Steer"),
      mode: "steering",
      payload: { model: TEST_MODEL },
    });

    expect(inbox.api.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "steering", model: TEST_MODEL })
    );
    expect(store.getInbox()).toHaveLength(1);

    // 第一条跑完，服务端接着领走第二条：它从队列里消失，同时以 user 回合的
    // 身份出现在记录里。
    events.runEnd("run-1", 3);
    await vi.waitFor(() => expect(store.getStatus()).toBe("ready"));

    events.runStart("run-2", 4, ["u2"]);
    events.runEvent("run-2", 5, {
      type: "turn.start",
      turnId: "turn-2",
      turnType: "assistant",
      createdAt: 1,
    });

    await vi.waitFor(() => expect(store.getInbox()).toHaveLength(0));
    await vi.waitFor(() =>
      expect(store.getTurns().map((turn) => turn.id)).toStrictEqual([
        "u1",
        "turn-1",
        "u2",
        "turn-2",
      ])
    );

    events.close();
  });

  test("one run adopts every queued message it claims", async () => {
    const events = sessionEvents();
    const inbox = createInbox();
    const store = storeOf({
      apiInbox: inbox.api,
      apiEvents: () => Promise.resolve(events.stream),
      apiSend: () => Promise.resolve(),
    });

    await store.submit({
      turn: userTurn("u1", "Start"),
      payload: { model: TEST_MODEL },
    });
    await flush();

    events.runStart("run-1", 1, ["u1"]);
    events.runEvent("run-1", 2, {
      type: "turn.start",
      turnId: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await vi.waitFor(() => expect(store.getStatus()).toBe("streaming"));

    await store.submit({
      turn: userTurn("u2", "One"),
      mode: "followup",
      payload: { model: TEST_MODEL },
    });
    await store.submit({
      turn: userTurn("u3", "Two"),
      mode: "followup",
      payload: { model: TEST_MODEL },
    });
    expect(store.getInbox()).toHaveLength(2);

    events.runEnd("run-1", 3);
    await vi.waitFor(() => expect(store.getStatus()).toBe("ready"));

    // 第二次运行一次领走两条：队列同时清空，两条按顺序进记录。
    events.runStart("run-2", 4, ["u2", "u3"]);
    events.runEvent("run-2", 5, {
      type: "turn.start",
      turnId: "turn-2",
      turnType: "assistant",
      createdAt: 1,
    });

    await vi.waitFor(() => expect(store.getInbox()).toHaveLength(0));
    await vi.waitFor(() =>
      expect(store.getTurns().map((turn) => turn.id)).toStrictEqual([
        "u1",
        "turn-1",
        "u2",
        "u3",
        "turn-2",
      ])
    );

    events.close();
  });

  test("a dropped stream reconnects with the cursor and keeps the run", async () => {
    const cursors: (string | undefined)[] = [];
    const first = sessionEvents();
    const second = sessionEvents();

    const store = createAgentSessionStore({
      id: "session-1",
      apiEvents: (options) => {
        cursors.push(options.since);
        return Promise.resolve(
          cursors.length === 1 ? first.stream : second.stream
        );
      },
      throttleMs: 0,
      turns: [],
      emit: () => {},
    });

    await flush();

    first.send({ type: "ready", epoch: "epoch-1", seq: 0 });
    first.runStart("run-1", 1);
    await vi.waitFor(() => expect(store.getStatus()).toBe("streaming"));

    // 连接断了：不落定，带着读到的游标再接一次。
    first.close();

    // 第一次重连前会等一会儿：给它比默认窗口更长的余地。
    await vi.waitFor(() => expect(cursors).toHaveLength(2), { timeout: 5000 });
    expect(cursors[0]).toBeUndefined();
    expect(cursors[1]).toBe("epoch-1:1");
    expect(store.getStatus()).toBe("streaming");

    // 同一次运行的续读：重放的 `run.start` 不再新建装配器。
    second.runStart("run-1", 1);
    second.runEnd("run-1", 2);
    await vi.waitFor(() => expect(store.getStatus()).toBe("ready"));

    second.close();
  });

  test("a turn.steer event removes the matching pending message", async () => {
    const events = sessionEvents();
    const inbox = createInbox();
    const store = storeOf({
      apiInbox: inbox.api,
      apiEvents: () => Promise.resolve(events.stream),
      apiSend: () => Promise.resolve(),
    });

    await store.submit({
      turn: userTurn("u1", "Start"),
      payload: { model: TEST_MODEL },
    });
    await flush();

    events.runStart("run-1", 1, ["u1"]);
    events.runEvent("run-1", 2, {
      type: "turn.start",
      turnId: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });

    await vi.waitFor(() => expect(store.getStatus()).toBe("streaming"));

    await store.submit({
      turn: userTurn("u2", "Steer"),
      mode: "steering",
      payload: { model: TEST_MODEL },
    });

    const [pending] = store.getInbox();
    expect(pending).toBeDefined();

    events.runEvent("run-1", 3, {
      type: "turn.steer",
      turnId: "turn-1",
      step: {
        id: pending!.id,
        type: "steering",
        createdAt: 2,
        completedAt: 2,
        status: "done",
        content: [{ type: "text", text: "Steer", createdAt: 2 }],
      },
      createdAt: 2,
    } satisfies AgentStreamEvent<never>);

    await vi.waitFor(() => expect(store.getInbox()).toHaveLength(0));

    events.close();
  });

  test("stopping settles the run; sending again asks the server to continue", async () => {
    const events = sessionEvents();
    const resumes: { sessionId: string }[] = [];
    const inbox = createInbox();
    const store = storeOf({
      apiInbox: inbox.api,
      apiEvents: () => Promise.resolve(events.stream),
      apiSend: () => Promise.resolve(),
      apiStop: () => Promise.resolve(),
      apiResume: (options) => {
        resumes.push(options);
        return Promise.resolve();
      },
    });

    await store.submit({
      turn: userTurn("u1", "Start"),
      payload: { model: TEST_MODEL },
    });
    await flush();

    events.runStart("run-1", 1, ["u1"]);
    await vi.waitFor(() => expect(store.getStatus()).toBe("streaming"));

    await store.submit({
      turn: userTurn("u2", "Steer"),
      mode: "steering",
      payload: { model: TEST_MODEL },
    });
    expect(store.getInbox()).toHaveLength(1);

    await store.stop();
    await vi.waitFor(() => expect(store.getStatus()).toBe("ready"));

    // 停止不发送队列里的消息：它们留在队列里，等用户说继续。
    expect(store.getInbox()).toHaveLength(1);

    await store.sendPending();
    expect(resumes).toStrictEqual([{ sessionId: "session-1" }]);

    events.close();
  });

  test("cancels one pending message and clears the rest", async () => {
    const events = sessionEvents();
    const inbox = createInbox();
    const store = storeOf({
      apiInbox: inbox.api,
      apiEvents: () => Promise.resolve(events.stream),
      apiSend: () => Promise.resolve(),
    });

    await store.submit({
      turn: userTurn("u1", "Start"),
      payload: { model: TEST_MODEL },
    });
    await flush();

    events.runStart("run-1", 1, ["u1"]);
    await vi.waitFor(() => expect(store.getStatus()).toBe("streaming"));

    await store.submit({
      turn: userTurn("u2", "One"),
      mode: "steering",
      payload: { model: TEST_MODEL },
    });

    const [firstPending] = store.getInbox();
    await store.cancelPending(firstPending!.id);
    expect(store.getInbox()).toStrictEqual([]);

    await store.submit({
      turn: userTurn("u3", "Two"),
      mode: "steering",
      payload: { model: TEST_MODEL },
    });
    expect(store.getInbox()).toHaveLength(1);

    await store.clearPending();
    expect(store.getInbox()).toStrictEqual([]);

    events.close();
  });

  test("reads the session again after the page came back", async () => {
    const opened: ReturnType<typeof sessionEvents>[] = [];
    const store = storeOf({
      apiInbox: createInbox().api,
      apiEvents: () => {
        const events = sessionEvents();
        opened.push(events);

        return Promise.resolve(events.stream);
      },
      apiSend: () => Promise.resolve(),
    });

    await vi.waitFor(() => expect(opened).toHaveLength(1));

    // 页面卸载：连接停掉。开发期的 StrictMode 挂载时就会先走这一步。
    store.destroy();
    // 页面回来：必须再开一条，否则发送之后没有任何事件到达。
    store.start();
    await vi.waitFor(() => expect(opened).toHaveLength(2));

    opened[1]!.runStart("run-1", 1);
    opened[1]!.runEvent("run-1", 2, {
      type: "turn.start",
      turnId: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });

    await vi.waitFor(() => expect(store.getStatus()).toBe("streaming"));

    opened[1]!.close();
  });
});
