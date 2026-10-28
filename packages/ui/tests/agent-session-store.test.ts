import type {
  AgentStreamEvent,
  AgentUserTurn,
  InboxMessage,
} from "@workspace/agent-client";
import { describe, expect, test, vi } from "vitest";

import { createAgentSessionStore } from "../src/hooks/use-agent-session";
import type { InboxApi } from "../src/hooks/use-agent-session";

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
  placement: "next-step" | "next-turn" = "next-turn"
): InboxMessage => ({
  seq,
  id,
  sessionId: "session-1",
  requestId: `request-${id}`,
  placement,
  content,
  payload: { model: "test-model" },
  createdAt: 1,
});

const closedStream = (): ReadableStream =>
  new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

/** A stream the test ends by hand, standing in for a turn still running. */
const deferredStream = () => {
  let controller!: ReadableStreamDefaultController<unknown>;
  const stream = new ReadableStream<unknown>({
    start(controllerArg) {
      controller = controllerArg;
    },
  });
  return { controller, stream };
};

const createInbox = (seed: InboxMessage[] = []) => {
  let messages = [...seed];

  const api: InboxApi = {
    list: vi.fn<InboxApi["list"]>(() => Promise.resolve([...messages])),
    enqueue: vi.fn<InboxApi["enqueue"]>((input) => {
      const message = inboxMessage(
        input.requestId,
        messages.length,
        input.turn,
        input.mode === "steering" ? "next-step" : "next-turn"
      );
      messages = [...messages, message];
      return Promise.resolve({ message });
    }),
    cancel: vi.fn<InboxApi["cancel"]>((input) => {
      messages = messages.filter((message) => message.id !== input.messageId);
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

const storeOf = (input: {
  apiInbox: InboxApi;
  apiStream: (options: Record<string, unknown>) => Promise<ReadableStream>;
  apiStop?: () => Promise<unknown>;
}) =>
  createAgentSessionStore({
    id: "session-1",
    apiInbox: input.apiInbox,
    apiStream: input.apiStream as never,
    apiStop: input.apiStop,
    turns: [],
    emit: () => {
      // The store only forwards stream events; the assertions read its state.
    },
  });

describe("createAgentSessionStore queue", () => {
  test("a new session sends directly and resolves once the stream is accepted", async () => {
    const calls: Record<string, unknown>[] = [];
    const store = createAgentSessionStore({
      id: "session-1",
      turns: [],
      apiStream: (options) => {
        calls.push(options);
        return Promise.resolve(closedStream());
      },
      emit: () => {
        // no-op
      },
    });

    await store.submit({
      turn: userTurn("u1", "Hello"),
      payload: { model: "test-model" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.turns).toHaveLength(1);
  });

  test("queues a steering message while a turn is running, then drains it", async () => {
    const first = deferredStream();
    const calls: Record<string, unknown>[] = [];
    const inbox = createInbox();
    const store = storeOf({
      apiInbox: inbox.api,
      apiStream: (options) => {
        if (typeof options.inboxId === "string") {
          inbox.claim(options.inboxId);
        }
        calls.push(options);
        return Promise.resolve(
          calls.length === 1 ? first.stream : closedStream()
        );
      },
    });

    await store.submit({
      turn: userTurn("u1", "Start"),
      payload: { model: "test-model" },
    });
    await store.submit({
      turn: userTurn("u2", "Steer"),
      mode: "steering",
      payload: { model: "test-model" },
    });

    expect(inbox.api.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "steering", model: "test-model" })
    );
    expect(store.getInbox()).toHaveLength(1);

    const [pending] = store.getInbox();
    expect(pending).toBeDefined();

    // 结束当前回合：settle 刷新队列后自动发下一条。
    first.controller.close();

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.inboxId).toBe(pending?.id);
    await vi.waitFor(() => expect(store.getInbox()).toHaveLength(0));
  });

  test("a turn.steer event removes the matching pending message", async () => {
    const first = deferredStream();
    const calls: Record<string, unknown>[] = [];
    const inbox = createInbox();
    const store = storeOf({
      apiInbox: inbox.api,
      apiStream: (options) => {
        if (typeof options.inboxId === "string") {
          inbox.claim(options.inboxId);
        }
        calls.push(options);
        return Promise.resolve(
          calls.length === 1 ? first.stream : closedStream()
        );
      },
    });

    await store.submit({
      turn: userTurn("u1", "Start"),
      payload: { model: "test-model" },
    });
    await store.submit({
      turn: userTurn("u2", "Steer"),
      mode: "steering",
      payload: { model: "test-model" },
    });

    const [pending] = store.getInbox();
    expect(pending).toBeDefined();

    first.controller.enqueue({
      type: "turn.steer",
      turnId: "turn-a",
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

    first.controller.close();
  });

  test("stopping pauses automatic draining until the user sends again", async () => {
    const first = deferredStream();
    const calls: Record<string, unknown>[] = [];
    const inbox = createInbox();
    const store = storeOf({
      apiInbox: inbox.api,
      apiStop: () => Promise.resolve(),
      apiStream: (options) => {
        if (typeof options.inboxId === "string") {
          inbox.claim(options.inboxId);
        }
        calls.push(options);
        return Promise.resolve(
          calls.length === 1 ? first.stream : closedStream()
        );
      },
    });

    await store.submit({
      turn: userTurn("u1", "Start"),
      payload: { model: "test-model" },
    });
    await store.submit({
      turn: userTurn("u2", "Steer"),
      mode: "steering",
      payload: { model: "test-model" },
    });
    expect(store.getInbox()).toHaveLength(1);

    await store.stop();
    first.controller.close();
    await vi.waitFor(() => expect(store.getStatus()).toBe("ready"));

    // 停止后不自动发送，消息仍留在队列里。
    expect(calls).toHaveLength(1);
    expect(store.getInbox()).toHaveLength(1);

    await store.sendPending();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await vi.waitFor(() => expect(store.getInbox()).toHaveLength(0));
  });

  test("cancels one pending message and clears the rest", async () => {
    const first = deferredStream();
    const calls: Record<string, unknown>[] = [];
    const inbox = createInbox();
    const store = storeOf({
      apiInbox: inbox.api,
      apiStream: (options) => {
        if (typeof options.inboxId === "string") {
          inbox.claim(options.inboxId);
        }
        calls.push(options);
        return Promise.resolve(
          calls.length === 1 ? first.stream : closedStream()
        );
      },
    });

    await store.submit({
      turn: userTurn("u1", "Start"),
      payload: { model: "test-model" },
    });
    await store.submit({
      turn: userTurn("u2", "One"),
      mode: "steering",
      payload: { model: "test-model" },
    });

    const [firstPending] = store.getInbox();
    await store.cancelPending(firstPending!.id);
    expect(store.getInbox()).toStrictEqual([]);

    await store.submit({
      turn: userTurn("u3", "Two"),
      mode: "steering",
      payload: { model: "test-model" },
    });
    expect(store.getInbox()).toHaveLength(1);

    await store.clearPending();
    expect(store.getInbox()).toStrictEqual([]);

    first.controller.close();
  });
});
