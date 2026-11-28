import type {
  AgentAssistantTurn,
  AgentStaticToolPart,
  AgentStreamEvent,
  AgentToolSet,
  AgentTurn,
  AgentUserTurn,
  InboxItem,
  SessionStreamEvent,
} from "@workspace/agent-client";
import { describe, expect, test, vi } from "vitest";

import { createSessionClient } from "../src/lib/session-client";
import type {
  InboxTransport,
  SendSessionInput,
  SessionTransport,
  SessionWriteTransport,
} from "../src/lib/session-client";

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

const inboxItem = (
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

const heldTurns = (
  approvalIds: readonly string[] = ["ap-1"]
): AgentTurn<AgentToolSet>[] =>
  [
    {
      id: "turn-1",
      type: "assistant",
      createdAt: 1,
      status: "wait_review",
      content: [
        {
          id: "step-1",
          type: "assistant",
          model: "test-model",
          createdAt: 1,
          status: "done",
          content: approvalIds.map((approvalId, index) => ({
            type: "tool-bash",
            toolCallId: `call-${index + 1}`,
            rawInput: "",
            state: "approval-requested",
            input: {},
            approval: { id: approvalId, createdAt: 1 },
          })),
        },
      ],
    },
  ] as unknown as AgentTurn<AgentToolSet>[];

const heldPart = (
  turns: AgentTurn<AgentToolSet>[],
  index = 0
): AgentStaticToolPart<AgentToolSet> => {
  const turn = turns[0] as AgentAssistantTurn<AgentToolSet>;
  return turn.content[0]!.content[index] as AgentStaticToolPart<AgentToolSet>;
};

const sessionEvents = () => {
  let controller!: ReadableStreamDefaultController<
    SessionStreamEvent<AgentToolSet>
  >;

  const stream = new ReadableStream<SessionStreamEvent<AgentToolSet>>({
    start(controllerArg) {
      controller = controllerArg;
    },
  });

  return {
    close: () => controller.close(),
    runEnd: (streamId: string, seq: number) =>
      controller.enqueue({ seq, streamId, type: "run.end" }),
    runEvent: (
      streamId: string,
      seq: number,
      event: AgentStreamEvent<AgentToolSet>
    ) => controller.enqueue({ event, seq, streamId, type: "run.event" }),
    runStart: (streamId: string, seq: number, turnIds?: readonly string[]) =>
      controller.enqueue({
        seq,
        streamId,
        type: "run.start",
        ...(turnIds === undefined ? {} : { turnIds }),
      }),
    send: (event: SessionStreamEvent<AgentToolSet>) =>
      controller.enqueue(event),
    stream,
  };
};

const createInbox = (seed: InboxItem[] = []) => {
  let items = [...seed];

  const inbox: InboxTransport = {
    list: vi.fn<InboxTransport["list"]>(() => Promise.resolve([...items])),
    enqueue: vi.fn<InboxTransport["enqueue"]>((input) => {
      const item = inboxItem(
        input.dedupeKey,
        items.length,
        input.turn,
        input.mode === "steering" ? "step-boundary" : "run-boundary"
      );
      items = [...items, item];
      return Promise.resolve({ item });
    }),
    cancel: vi.fn<InboxTransport["cancel"]>((input) => {
      items = items.filter((item) => item.id !== input.itemId);
      return Promise.resolve({ removed: 1 });
    }),
    clear: vi.fn<InboxTransport["clear"]>(() => {
      items = [];
      return Promise.resolve({ removed: 1 });
    }),
  };

  return {
    inbox,
    getItems: () => items,
  };
};

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const noEvents = (): ReturnType<SessionTransport["openEvents"]> =>
  Promise.resolve(undefined as never);

const createTestTransport = (input: {
  loadTurns?: SessionTransport["loadTurns"];
  openEvents?: SessionTransport["openEvents"];
  write?: Partial<SessionWriteTransport> & { inbox?: InboxTransport };
  readOnly?: boolean;
}): SessionTransport => {
  const defaultEvents = sessionEvents();
  return {
    loadTurns: input.loadTurns ?? (() => Promise.resolve([])),
    openEvents:
      input.openEvents ?? (() => Promise.resolve(defaultEvents.stream)),
    ...(input.readOnly
      ? {}
      : {
          write: {
            send: input.write?.send ?? (() => Promise.resolve()),
            resume: input.write?.resume ?? (() => Promise.resolve()),
            stop: input.write?.stop ?? (() => Promise.resolve()),
            inbox: input.write?.inbox ?? createInbox().inbox,
          },
        }),
  };
};

describe("createSessionClient lifecycle and hydration", () => {
  test("construction performs zero I/O until start() is called", () => {
    const loadTurns = vi.fn<SessionTransport["loadTurns"]>(() =>
      Promise.resolve([])
    );
    const openEvents = vi.fn<SessionTransport["openEvents"]>(noEvents);
    const inbox = createInbox();

    const client = createSessionClient({
      id: "session-1",
      transport: createTestTransport({
        loadTurns,
        openEvents,
        write: { inbox: inbox.inbox },
      }),
    });

    expect(client.isHydrated()).toBeFalsy();
    expect(loadTurns).not.toHaveBeenCalled();
    expect(openEvents).not.toHaveBeenCalled();
    expect(inbox.inbox.list).not.toHaveBeenCalled();
  });

  test("hydrates initial turns before opening events or listing inbox", async () => {
    const events = sessionEvents();
    const order: string[] = [];
    const seededTurn = userTurn("u0", "Seeded");
    const inbox = createInbox();
    const inboxTransport: InboxTransport = {
      ...inbox.inbox,
      list: vi.fn<InboxTransport["list"]>(() => {
        order.push("inbox.list");
        return Promise.resolve(inbox.getItems());
      }),
    };

    const client = createSessionClient({
      id: "session-1",
      transport: createTestTransport({
        loadTurns: async () => {
          order.push("loadTurns:start");
          await flush();
          order.push("loadTurns:end");
          return [seededTurn];
        },
        openEvents: () => {
          order.push("openEvents");
          return Promise.resolve(events.stream);
        },
        write: { inbox: inboxTransport },
      }),
    });

    client.start();
    expect(client.isHydrated()).toBeFalsy();
    expect(order).toStrictEqual(["loadTurns:start"]);

    await vi.waitFor(() => expect(client.isHydrated()).toBeTruthy());
    expect(client.getTurns()).toStrictEqual([seededTurn]);
    await vi.waitFor(() => expect(order).toHaveLength(4));
    expect(order).toStrictEqual([
      "loadTurns:start",
      "loadTurns:end",
      "openEvents",
      "inbox.list",
    ]);
    expect(inboxTransport.list).toHaveBeenCalledOnce();

    client.destroy();
    events.close();
  });

  test("draft session skips loadTurns and is hydrated immediately", async () => {
    const events = sessionEvents();
    const loadTurns = vi.fn<SessionTransport["loadTurns"]>(() =>
      Promise.resolve([])
    );
    const openEvents = vi.fn<SessionTransport["openEvents"]>(() =>
      Promise.resolve(events.stream)
    );

    const client = createSessionClient({
      id: "session-draft",
      hydrate: false,
      transport: createTestTransport({ loadTurns, openEvents }),
    });

    expect(client.isHydrated()).toBeTruthy();
    client.start();

    await vi.waitFor(() => expect(openEvents).toHaveBeenCalledOnce());
    expect(loadTurns).not.toHaveBeenCalled();

    client.destroy();
    events.close();
  });

  test("hydration failure sets error state, marks hydrated, and skips openEvents", async () => {
    const openEvents = vi.fn<SessionTransport["openEvents"]>(noEvents);

    const client = createSessionClient({
      id: "session-1",
      transport: createTestTransport({
        loadTurns: () => Promise.reject(new Error("turns unavailable")),
        openEvents,
      }),
    });

    client.start();

    await vi.waitFor(() => expect(client.isHydrated()).toBeTruthy());
    expect(client.getStatus()).toBe("error");
    expect(client.getError()?.message).toBe("turns unavailable");
    expect(openEvents).not.toHaveBeenCalled();
  });

  test("destroy() during pending loadTurns ignores stale result and skips openEvents", async () => {
    let resolveLoad!: (turns: AgentTurn<AgentToolSet>[]) => void;
    const openEvents = vi.fn<SessionTransport["openEvents"]>(noEvents);

    const client = createSessionClient({
      id: "session-1",
      transport: createTestTransport({
        loadTurns: () =>
          new Promise((resolve) => {
            resolveLoad = resolve;
          }),
        openEvents,
      }),
    });

    client.start();
    client.destroy();

    resolveLoad([userTurn("u0", "Stale")]);
    await flush();

    expect(client.isHydrated()).toBeFalsy();
    expect(client.getTurns()).toStrictEqual([]);
    expect(openEvents).not.toHaveBeenCalled();
  });

  test("read-only transport never lists inbox and rejects submit", async () => {
    const events = sessionEvents();
    const openEvents = vi.fn<SessionTransport["openEvents"]>(() =>
      Promise.resolve(events.stream)
    );

    const client = createSessionClient({
      id: "subagent-1",
      hydrate: false,
      transport: createTestTransport({
        openEvents,
        readOnly: true,
      }),
    });

    client.start();
    await vi.waitFor(() => expect(openEvents).toHaveBeenCalledOnce());

    await expect(
      client.submit({
        turn: userTurn("u1", "Blocked"),
        payload: { model: TEST_MODEL },
      })
    ).rejects.toThrow("This session is read-only.");

    client.destroy();
    events.close();
  });
});

describe("createSessionClient queue", () => {
  test("a new session sends directly and waits for run.start", async () => {
    const events = sessionEvents();
    const calls: SendSessionInput[] = [];
    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
        write: {
          send: (input) => {
            calls.push(input);
            return Promise.resolve();
          },
        },
      }),
    });
    client.start();
    await flush();

    await client.submit({
      turn: userTurn("u1", "Hello"),
      payload: { model: TEST_MODEL },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.turns).toHaveLength(1);
    expect(calls[0]?.payload.model).toStrictEqual(TEST_MODEL);
    expect(client.getStatus()).toBe("submitted");

    events.runStart("run-1", 1, ["u1"]);
    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));

    events.runEnd("run-1", 2);
    await vi.waitFor(() => expect(client.getStatus()).toBe("ready"));

    client.destroy();
    events.close();
  });

  test("a queued message leaves the queue when the server starts its run", async () => {
    const events = sessionEvents();
    const inbox = createInbox();
    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
        write: { inbox: inbox.inbox },
      }),
    });
    client.start();

    await client.submit({
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

    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));

    await client.submit({
      turn: userTurn("u2", "Steer"),
      mode: "steering",
      payload: { model: TEST_MODEL },
    });

    expect(inbox.inbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "steering", model: TEST_MODEL })
    );
    expect(client.getInbox()).toHaveLength(1);

    events.runEnd("run-1", 3);
    await vi.waitFor(() => expect(client.getStatus()).toBe("ready"));

    events.runStart("run-2", 4, ["u2"]);
    events.runEvent("run-2", 5, {
      type: "turn.start",
      turnId: "turn-2",
      turnType: "assistant",
      createdAt: 1,
    });

    await vi.waitFor(() => expect(client.getInbox()).toHaveLength(0));
    await vi.waitFor(() =>
      expect(client.getTurns().map((turn) => turn.id)).toStrictEqual([
        "u1",
        "turn-1",
        "u2",
        "turn-2",
      ])
    );

    client.destroy();
    events.close();
  });

  test("one run adopts every queued message it claims", async () => {
    const events = sessionEvents();
    const inbox = createInbox();
    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
        write: { inbox: inbox.inbox },
      }),
    });
    client.start();

    await client.submit({
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
    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));

    await client.submit({
      turn: userTurn("u2", "One"),
      mode: "followup",
      payload: { model: TEST_MODEL },
    });
    await client.submit({
      turn: userTurn("u3", "Two"),
      mode: "followup",
      payload: { model: TEST_MODEL },
    });
    expect(client.getInbox()).toHaveLength(2);

    events.runEnd("run-1", 3);
    await vi.waitFor(() => expect(client.getStatus()).toBe("ready"));

    events.runStart("run-2", 4, ["u2", "u3"]);
    events.runEvent("run-2", 5, {
      type: "turn.start",
      turnId: "turn-2",
      turnType: "assistant",
      createdAt: 1,
    });

    await vi.waitFor(() => expect(client.getInbox()).toHaveLength(0));
    await vi.waitFor(() =>
      expect(client.getTurns().map((turn) => turn.id)).toStrictEqual([
        "u1",
        "turn-1",
        "u2",
        "u3",
        "turn-2",
      ])
    );

    client.destroy();
    events.close();
  });

  test("a dropped stream reconnects with the cursor and keeps the run", async () => {
    const cursors: (string | undefined)[] = [];
    const first = sessionEvents();
    const second = sessionEvents();

    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      throttleMs: 0,
      transport: createTestTransport({
        openEvents: (options) => {
          cursors.push(options.since);
          return Promise.resolve(
            cursors.length === 1 ? first.stream : second.stream
          );
        },
        readOnly: true,
      }),
    });
    client.start();

    await flush();

    first.send({ type: "ready", epoch: "epoch-1", seq: 0 });
    first.runStart("run-1", 1);
    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));

    first.close();

    await vi.waitFor(() => expect(cursors).toHaveLength(2), { timeout: 5000 });
    expect(cursors[0]).toBeUndefined();
    expect(cursors[1]).toBe("epoch-1:1");
    expect(client.getStatus()).toBe("streaming");

    second.runStart("run-1", 1);
    second.runEnd("run-1", 2);
    await vi.waitFor(() => expect(client.getStatus()).toBe("ready"));

    client.destroy();
    second.close();
  });

  test("a turn.steer event removes the matching pending message", async () => {
    const events = sessionEvents();
    const inbox = createInbox();
    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
        write: { inbox: inbox.inbox },
      }),
    });
    client.start();

    await client.submit({
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

    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));

    await client.submit({
      turn: userTurn("u2", "Steer"),
      mode: "steering",
      payload: { model: TEST_MODEL },
    });

    const [pending] = client.getInbox();
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
    } satisfies AgentStreamEvent<AgentToolSet>);

    await vi.waitFor(() => expect(client.getInbox()).toHaveLength(0));

    client.destroy();
    events.close();
  });

  test("stopping settles the run; sending again asks the server to continue", async () => {
    const events = sessionEvents();
    const resumes: { sessionId: string }[] = [];
    const inbox = createInbox();
    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
        write: {
          inbox: inbox.inbox,
          resume: (options) => {
            resumes.push(options);
            return Promise.resolve();
          },
        },
      }),
    });
    client.start();

    await client.submit({
      turn: userTurn("u1", "Start"),
      payload: { model: TEST_MODEL },
    });
    await flush();

    events.runStart("run-1", 1, ["u1"]);
    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));

    await client.submit({
      turn: userTurn("u2", "Steer"),
      mode: "steering",
      payload: { model: TEST_MODEL },
    });
    expect(client.getInbox()).toHaveLength(1);

    await client.stop();
    await vi.waitFor(() => expect(client.getStatus()).toBe("ready"));

    expect(client.getInbox()).toHaveLength(1);

    await client.sendPending();
    expect(resumes).toStrictEqual([{ sessionId: "session-1" }]);

    client.destroy();
    events.close();
  });

  test("cancels one pending message and clears the rest", async () => {
    const events = sessionEvents();
    const inbox = createInbox();
    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
        write: { inbox: inbox.inbox },
      }),
    });
    client.start();

    await client.submit({
      turn: userTurn("u1", "Start"),
      payload: { model: TEST_MODEL },
    });
    await flush();

    events.runStart("run-1", 1, ["u1"]);
    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));

    await client.submit({
      turn: userTurn("u2", "One"),
      mode: "steering",
      payload: { model: TEST_MODEL },
    });

    const [firstPending] = client.getInbox();
    await client.cancelPending(firstPending!.id);
    expect(client.getInbox()).toStrictEqual([]);

    await client.submit({
      turn: userTurn("u3", "Two"),
      mode: "steering",
      payload: { model: TEST_MODEL },
    });
    expect(client.getInbox()).toHaveLength(1);

    await client.clearPending();
    expect(client.getInbox()).toStrictEqual([]);

    client.destroy();
    events.close();
  });

  test("reads the session again after destroy without re-hydrating already loaded turns", async () => {
    const opened: ReturnType<typeof sessionEvents>[] = [];
    const loadTurns = vi.fn<SessionTransport["loadTurns"]>(() =>
      Promise.resolve([])
    );

    const client = createSessionClient({
      id: "session-1",
      transport: createTestTransport({
        loadTurns,
        openEvents: () => {
          const events = sessionEvents();
          opened.push(events);
          return Promise.resolve(events.stream);
        },
      }),
    });
    client.start();

    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(loadTurns).toHaveBeenCalledOnce();

    client.destroy();
    client.start();
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(loadTurns).toHaveBeenCalledOnce();

    opened[1]!.runStart("run-1", 1);
    opened[1]!.runEvent("run-1", 2, {
      type: "turn.start",
      turnId: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });

    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));

    client.destroy();
    opened[1]!.close();
  });

  test("optimistically shows the first turn and keeps submitted until run.start", async () => {
    const events = sessionEvents();
    let resolveSend!: () => void;
    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
        write: {
          send: () =>
            new Promise<void>((resolve) => {
              resolveSend = resolve;
            }),
        },
      }),
    });
    client.start();

    await flush();

    const pendingSubmit = client.submit({
      turn: userTurn("u1", "Hello first"),
      payload: { model: TEST_MODEL },
    });

    expect(client.getTurns().map((turn) => turn.id)).toStrictEqual(["u1"]);
    expect(client.getStatus()).toBe("submitted");

    resolveSend();
    await pendingSubmit;

    expect(client.getTurns().map((turn) => turn.id)).toStrictEqual(["u1"]);
    expect(client.getStatus()).toBe("submitted");

    events.runStart("run-1", 1, ["u1"]);
    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));
    expect(client.getTurns().map((turn) => turn.id)).toStrictEqual(["u1"]);

    client.destroy();
    events.close();
  });

  test("rolls back the optimistic first turn when write.send rejects", async () => {
    const events = sessionEvents();
    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
        write: {
          send: () => Promise.reject(new Error("network failed")),
        },
      }),
    });
    client.start();

    await flush();

    await expect(
      client.submit({
        turn: userTurn("u1", "Will fail"),
        payload: { model: TEST_MODEL },
      })
    ).rejects.toThrow("network failed");

    expect(client.getTurns()).toStrictEqual([]);
    expect(client.getStatus()).toBe("error");

    client.destroy();
    events.close();
  });

  test("rolls back the optimistic turn and reconciles inbox when startup fails on stream", async () => {
    const events = sessionEvents();
    const firstTurn = userTurn("u1", "Startup fails");
    let serverInbox: InboxItem[] = [];
    const inbox: InboxTransport = {
      list: vi.fn<InboxTransport["list"]>(() =>
        Promise.resolve([...serverInbox])
      ),
      enqueue: vi.fn<InboxTransport["enqueue"]>(),
      cancel: vi.fn<InboxTransport["cancel"]>(() => Promise.resolve()),
      clear: vi.fn<InboxTransport["clear"]>(() => Promise.resolve()),
    };

    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
        write: {
          inbox,
          send: () => {
            serverInbox = [inboxItem("item-1", 0, firstTurn)];
            return Promise.resolve();
          },
        },
      }),
    });
    client.start();

    await flush();

    await client.submit({
      turn: firstTurn,
      payload: { model: TEST_MODEL },
    });

    expect(client.getTurns().map((turn) => turn.id)).toStrictEqual(["u1"]);
    expect(client.getStatus()).toBe("submitted");

    events.send({ seq: 1, streamId: "failed-run", type: "run.start" });
    events.send({
      failure: "model is not configured",
      seq: 2,
      streamId: "failed-run",
      type: "run.end",
    });

    await vi.waitFor(() => expect(client.getStatus()).toBe("error"));
    expect(client.getTurns()).toStrictEqual([]);
    await vi.waitFor(() =>
      expect(client.getInbox().map((item) => item.id)).toStrictEqual(["item-1"])
    );

    client.destroy();
    events.close();
  });

  test("stopping while submitted settles status back to ready", async () => {
    const events = sessionEvents();
    const stops: unknown[] = [];
    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
        write: {
          stop: () => {
            stops.push(true);
            return Promise.resolve();
          },
        },
      }),
    });
    client.start();

    await flush();

    await client.submit({
      turn: userTurn("u1", "Stop before run.start"),
      payload: { model: TEST_MODEL },
    });

    expect(client.getStatus()).toBe("submitted");

    await client.stop();

    expect(stops).toHaveLength(1);
    expect(client.getStatus()).toBe("ready");

    client.destroy();
    events.close();
  });

  test("serializes rapid inbox enqueues so items stay in send order", async () => {
    const events = sessionEvents();
    const order: string[] = [];
    const resolvers: ((item: InboxItem) => void)[] = [];
    const inbox: InboxTransport = {
      list: vi.fn<InboxTransport["list"]>(() => Promise.resolve([])),
      enqueue: vi.fn<InboxTransport["enqueue"]>((input) => {
        order.push(input.turn.id);
        return new Promise<{ item: InboxItem }>((resolve) => {
          resolvers.push((item) => resolve({ item }));
        });
      }),
      cancel: vi.fn<InboxTransport["cancel"]>(() =>
        Promise.resolve({ removed: 1 })
      ),
      clear: vi.fn<InboxTransport["clear"]>(() =>
        Promise.resolve({ removed: 0 })
      ),
    };

    const client = createSessionClient({
      id: "session-1",
      transport: createTestTransport({
        loadTurns: () => Promise.resolve([userTurn("u0", "Initial turn")]),
        openEvents: () => Promise.resolve(events.stream),
        write: { inbox },
      }),
    });
    client.start();

    await vi.waitFor(() => expect(client.isHydrated()).toBeTruthy());

    const firstTurn = userTurn("u1", "First queued");
    const secondTurn = userTurn("u2", "Second queued");

    const firstSubmit = client.submit({
      turn: firstTurn,
      payload: { model: TEST_MODEL },
    });
    const secondSubmit = client.submit({
      turn: secondTurn,
      payload: { model: TEST_MODEL },
    });

    await vi.waitFor(() => expect(inbox.enqueue).toHaveBeenCalledOnce());
    expect(order).toStrictEqual(["u1"]);

    resolvers[0]!(inboxItem("item-1", 0, firstTurn));
    await firstSubmit;

    await vi.waitFor(() => expect(inbox.enqueue).toHaveBeenCalledTimes(2));
    expect(order).toStrictEqual(["u1", "u2"]);

    resolvers[1]!(inboxItem("item-2", 1, secondTurn));
    await secondSubmit;

    expect(client.getInbox().map((item) => item.id)).toStrictEqual([
      "item-1",
      "item-2",
    ]);

    client.destroy();
    events.close();
  });

  test("continues serialized enqueue chain after an earlier enqueue rejects", async () => {
    const events = sessionEvents();
    const secondTurn = userTurn("u2", "Second queued");
    let callCount = 0;
    const inbox: InboxTransport = {
      list: vi.fn<InboxTransport["list"]>(() => Promise.resolve([])),
      enqueue: vi.fn<InboxTransport["enqueue"]>(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.reject(new Error("first failed"));
        }
        return Promise.resolve({
          item: inboxItem("item-2", 0, secondTurn),
        });
      }),
      cancel: vi.fn<InboxTransport["cancel"]>(() =>
        Promise.resolve({ removed: 1 })
      ),
      clear: vi.fn<InboxTransport["clear"]>(() =>
        Promise.resolve({ removed: 0 })
      ),
    };

    const client = createSessionClient({
      id: "session-1",
      transport: createTestTransport({
        loadTurns: () => Promise.resolve([userTurn("u0", "Initial turn")]),
        openEvents: () => Promise.resolve(events.stream),
        write: { inbox },
      }),
    });
    client.start();

    await vi.waitFor(() => expect(client.isHydrated()).toBeTruthy());

    const firstSubmit = client.submit({
      turn: userTurn("u1", "First queued"),
      payload: { model: TEST_MODEL },
    });
    const secondSubmit = client.submit({
      turn: secondTurn,
      payload: { model: TEST_MODEL },
    });

    await expect(firstSubmit).rejects.toThrow("first failed");
    await expect(secondSubmit).resolves.toBeUndefined();
    expect(client.getInbox().map((item) => item.id)).toStrictEqual(["item-2"]);

    client.destroy();
    events.close();
  });
});

describe("addToolApprovalResponse", () => {
  test("answers the part on screen and sends the same answer", async () => {
    const calls: SendSessionInput[] = [];
    const events = sessionEvents();

    const client = createSessionClient({
      id: "session-1",
      throttleMs: 0,
      transport: createTestTransport({
        loadTurns: () => Promise.resolve(heldTurns()),
        openEvents: () => Promise.resolve(events.stream),
        write: {
          send: (options) => {
            calls.push(options);
            return Promise.resolve();
          },
        },
      }),
    });

    client.start();
    await vi.waitFor(() => expect(client.isHydrated()).toBeTruthy());

    await client.addToolApprovalResponse({
      approvalId: "ap-1",
      approved: true,
      reason: "looks safe",
      data: { scope: "session", remember: true },
      payload: { model: TEST_MODEL },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.model).toStrictEqual(TEST_MODEL);
    expect(calls[0]?.approvals).toStrictEqual([
      {
        type: "tool.approval-response",
        id: "call-1",
        approvalId: "ap-1",
        approved: true,
        reason: "looks safe",
        data: { scope: "session", remember: true },
        turnId: "turn-1",
        stepId: "step-1",
        createdAt: expect.any(Number),
      },
    ]);

    const part = heldPart(client.getTurns());
    expect(part.state).toBe("approval-responded");
    expect(part.approval).toMatchObject({
      approved: true,
      data: { scope: "session", remember: true },
    });

    client.destroy();
    events.close();
  });

  test("returns to ready while another approval remains held, then stays submitted on the final answer", async () => {
    const calls: SendSessionInput[] = [];
    const events = sessionEvents();

    const client = createSessionClient({
      id: "session-1",
      throttleMs: 0,
      transport: createTestTransport({
        loadTurns: () => Promise.resolve(heldTurns(["ap-1", "ap-2"])),
        openEvents: () => Promise.resolve(events.stream),
        write: {
          send: (options) => {
            calls.push(options);
            return Promise.resolve();
          },
        },
      }),
    });

    client.start();
    await vi.waitFor(() => expect(client.isHydrated()).toBeTruthy());

    await client.addToolApprovalResponse({
      approvalId: "ap-1",
      approved: true,
      payload: { model: TEST_MODEL },
    });

    expect(calls).toHaveLength(1);
    expect(client.getStatus()).toBe("ready");
    expect([
      heldPart(client.getTurns(), 0).state,
      heldPart(client.getTurns(), 1).state,
    ]).toStrictEqual(["approval-responded", "approval-requested"]);

    await client.addToolApprovalResponse({
      approvalId: "ap-2",
      approved: true,
      payload: { model: TEST_MODEL },
    });

    expect(calls).toHaveLength(2);
    expect(client.getStatus()).toBe("submitted");

    events.runStart("run-2", 1);
    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));

    client.destroy();
    events.close();
  });

  test("sends nothing for a question the transcript no longer holds", async () => {
    const calls: SendSessionInput[] = [];
    const events = sessionEvents();

    const client = createSessionClient({
      id: "session-1",
      throttleMs: 0,
      transport: createTestTransport({
        loadTurns: () => Promise.resolve(heldTurns()),
        openEvents: () => Promise.resolve(events.stream),
        write: {
          send: (options) => {
            calls.push(options);
            return Promise.resolve();
          },
        },
      }),
    });

    client.start();
    await vi.waitFor(() => expect(client.isHydrated()).toBeTruthy());

    await client.addToolApprovalResponse({
      approvalId: "ap-gone",
      approved: false,
      payload: { model: TEST_MODEL },
    });

    expect(calls).toHaveLength(0);
    expect(client.getStatus()).toBe("ready");
    expect(heldPart(client.getTurns()).state).toBe("approval-requested");

    client.destroy();
    events.close();
  });
});

describe("session events", () => {
  test("reads a run as one stretch of the session", async () => {
    const events = sessionEvents();

    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      throttleMs: 0,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
      }),
    });
    client.start();

    await flush();

    events.send({ type: "ready", epoch: "epoch-1", seq: 0 });
    events.send({ seq: 1, streamId: "run-1", type: "run.start" });
    events.send({
      event: {
        type: "turn.start",
        turnId: "turn-1",
        turnType: "assistant",
        createdAt: 1,
      },
      seq: 2,
      streamId: "run-1",
      type: "run.event",
    });
    events.send({
      event: {
        type: "text.start",
        id: "part-1",
        turnId: "turn-1",
        stepId: "step-1",
        createdAt: 1,
      },
      seq: 3,
      streamId: "run-1",
      type: "run.event",
    });

    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));
    expect(client.getTurns()).toHaveLength(1);

    events.send({ seq: 4, streamId: "run-1", type: "run.end" });

    await vi.waitFor(() => expect(client.getStatus()).toBe("ready"));
    expect(client.getTurns()[0]?.status).not.toBe("streaming");

    client.destroy();
    events.close();
  });

  test("a turn the page never sent enters the transcript", async () => {
    const events = sessionEvents();

    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      throttleMs: 0,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
      }),
    });
    client.start();

    await flush();

    const notice = {
      id: "turn-notice",
      type: "user",
      createdAt: 1,
      status: "done",
      content: [
        {
          id: "step-notice",
          type: "user",
          createdAt: 1,
          status: "done",
          source: "job-notice",
          content: [
            { type: "text", text: "background job finished", createdAt: 1 },
          ],
        },
      ],
    } as unknown as AgentUserTurn;

    events.send({ type: "ready", epoch: "epoch-1", seq: 0 });
    events.send({
      seq: 1,
      streamId: "run-1",
      turnIds: [notice.id],
      turns: [notice],
      type: "run.start",
    });
    events.send({
      event: {
        type: "turn.start",
        turnId: "turn-1",
        turnType: "assistant",
        createdAt: 1,
      },
      seq: 2,
      streamId: "run-1",
      type: "run.event",
    });

    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));
    expect(client.getTurns()[0]).toStrictEqual(notice);

    client.destroy();
    events.close();
  });

  test("a run that fails leaves the session in the error state", async () => {
    const events = sessionEvents();

    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      throttleMs: 0,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
      }),
    });
    client.start();

    await flush();

    events.send({ seq: 1, streamId: "run-1", type: "run.start" });
    events.send({
      failure: "model exploded",
      seq: 2,
      streamId: "run-1",
      type: "run.end",
    });

    await vi.waitFor(() => expect(client.getStatus()).toBe("error"));
    expect(client.getError()?.message).toBe("model exploded");

    client.destroy();
    events.close();
  });
});

describe("stop", () => {
  test("settles the run and tells the server, and keeps reading the session", async () => {
    const stops: { sessionId: string }[] = [];
    const events = sessionEvents();

    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      throttleMs: 0,
      transport: createTestTransport({
        openEvents: () => Promise.resolve(events.stream),
        write: {
          stop: (options) => {
            stops.push(options);
            return Promise.resolve();
          },
        },
      }),
    });
    client.start();

    await flush();

    events.send({ seq: 1, streamId: "run-1", type: "run.start" });
    events.send({
      event: {
        type: "turn.start",
        turnId: "turn-1",
        turnType: "assistant",
        createdAt: 1,
      },
      seq: 2,
      streamId: "run-1",
      type: "run.event",
    });

    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));

    await client.stop();

    expect(stops).toStrictEqual([{ sessionId: "session-1" }]);
    expect(client.getStatus()).toBe("ready");
    expect(client.getTurns().at(-1)?.status).toBe("aborted");

    events.send({ seq: 3, streamId: "run-2", type: "run.start" });

    await vi.waitFor(() => expect(client.getStatus()).toBe("streaming"));

    client.destroy();
    events.close();
  });

  test("asks the server even with nothing running, and never rejects", async () => {
    const stops: { sessionId: string }[] = [];

    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      throttleMs: 0,
      transport: createTestTransport({
        write: {
          stop: (options) => {
            stops.push(options);
            return Promise.reject(new Error("no reply is running"));
          },
        },
      }),
    });

    await client.stop();

    expect(stops).toStrictEqual([{ sessionId: "session-1" }]);
  });

  test("passes on whether the subagents end with the run", async () => {
    const stops: { sessionId: string; keepSubagents?: boolean }[] = [];

    const client = createSessionClient({
      id: "session-1",
      hydrate: false,
      throttleMs: 0,
      transport: createTestTransport({
        write: {
          stop: (options) => {
            stops.push(options);
            return Promise.resolve();
          },
        },
      }),
    });

    await client.stop({ keepSubagents: true });

    expect(stops).toStrictEqual([
      { sessionId: "session-1", keepSubagents: true },
    ]);
  });
});
