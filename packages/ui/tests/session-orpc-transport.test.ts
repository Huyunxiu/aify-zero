import { QueryClient } from "@tanstack/react-query";
import type {
  AgentToolSet,
  AgentUserTurn,
  InboxItem,
  SessionStreamEvent,
} from "@workspace/agent-client";
import { describe, expect, test, vi } from "vitest";

import {
  createOrpcSessionTransport,
  sessionTurnsQueryKey,
} from "../src/lib/session-orpc-transport";
import type { OrpcSessionRpc } from "../src/lib/session-orpc-transport";

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

async function* emptyEventStream() {
  yield* [];
}

const createFakeRpc = (
  overrides?: Partial<OrpcSessionRpc>
): OrpcSessionRpc => ({
  listSessionTurns: vi.fn<OrpcSessionRpc["listSessionTurns"]>(() =>
    Promise.resolve([])
  ),
  streamSessionEvents: vi.fn<OrpcSessionRpc["streamSessionEvents"]>(
    emptyEventStream as unknown as OrpcSessionRpc["streamSessionEvents"]
  ),
  createSession: vi.fn<OrpcSessionRpc["createSession"]>(() =>
    Promise.resolve({ ok: true } as never)
  ),
  resumeSession: vi.fn<OrpcSessionRpc["resumeSession"]>(() =>
    Promise.resolve({ ok: true } as never)
  ),
  stopSession: vi.fn<OrpcSessionRpc["stopSession"]>(() =>
    Promise.resolve({ ok: true } as never)
  ),
  listInboxItems: vi.fn<OrpcSessionRpc["listInboxItems"]>(() =>
    Promise.resolve({ items: [] })
  ),
  enqueueInboxItem: vi.fn<OrpcSessionRpc["enqueueInboxItem"]>(() =>
    Promise.resolve({ item: {} as InboxItem })
  ),
  cancelInboxItem: vi.fn<OrpcSessionRpc["cancelInboxItem"]>(() =>
    Promise.resolve({ removed: 1 })
  ),
  clearInboxItems: vi.fn<OrpcSessionRpc["clearInboxItems"]>(() =>
    Promise.resolve({ removed: 0 })
  ),
  ...overrides,
});

describe(createOrpcSessionTransport, () => {
  test("openEvents forwards the reconnect since cursor and decodes events", async () => {
    const readyEvent: SessionStreamEvent<AgentToolSet> = {
      type: "ready",
      epoch: "epoch-1",
      seq: 3,
    };
    const streamSessionEvents = vi.fn<OrpcSessionRpc["streamSessionEvents"]>(
      async function* streamSessionEvents() {
        yield readyEvent;
      } as unknown as OrpcSessionRpc["streamSessionEvents"]
    );
    const rpcClient = createFakeRpc({ streamSessionEvents });
    const transport = createOrpcSessionTransport({
      rpcClient,
      queryClient: new QueryClient(),
    });
    const controller = new AbortController();

    const first = await transport.openEvents({
      sessionId: "session-1",
      abortSignal: controller.signal,
    });
    expect(streamSessionEvents).toHaveBeenNthCalledWith(
      1,
      { sessionId: "session-1" },
      { signal: controller.signal }
    );
    const reader = first!.getReader();
    await expect(reader.read()).resolves.toStrictEqual({
      done: false,
      value: readyEvent,
    });
    reader.releaseLock();

    await transport.openEvents({
      sessionId: "session-1",
      since: "epoch-1:3",
      abortSignal: controller.signal,
    });
    expect(streamSessionEvents).toHaveBeenNthCalledWith(
      2,
      { sessionId: "session-1", since: "epoch-1:3" },
      { signal: controller.signal }
    );
  });

  test("loadTurns caches via QueryClient under listSessionTurns", async () => {
    const turn = userTurn("u1", "Saved turn");
    const listSessionTurns = vi.fn<OrpcSessionRpc["listSessionTurns"]>(() =>
      Promise.resolve([turn])
    );
    const rpcClient = createFakeRpc({ listSessionTurns });
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000 } },
    });
    const transport = createOrpcSessionTransport({
      rpcClient,
      queryClient: qc,
    });

    await expect(
      transport.loadTurns({ sessionId: "session-1" })
    ).resolves.toStrictEqual([turn]);
    await expect(
      transport.loadTurns({ sessionId: "session-1" })
    ).resolves.toStrictEqual([turn]);

    expect(listSessionTurns).toHaveBeenCalledExactlyOnceWith(
      { sessionId: "session-1" },
      { signal: expect.any(AbortSignal) }
    );
    expect(qc.getQueryData(sessionTurnsQueryKey("session-1"))).toStrictEqual([
      turn,
    ]);
  });

  test("write.send forwards typed payload, last turn or empty turns on approvals", async () => {
    const createSession = vi.fn<OrpcSessionRpc["createSession"]>(() =>
      Promise.resolve({ ok: true } as never)
    );
    const rpcClient = createFakeRpc({ createSession });
    const transport = createOrpcSessionTransport({
      rpcClient,
      queryClient: new QueryClient(),
    });
    const abortSignal = new AbortController().signal;
    const t1 = userTurn("u1", "First");
    const t2 = userTurn("u2", "Second");

    await transport.write!.send({
      sessionId: "session-1",
      turns: [t1, t2],
      abortSignal,
      payload: {
        model: TEST_MODEL,
        modelEffort: "high",
        botId: "bot-1",
        projectId: null,
        approvalPolicy: "unrestricted",
      },
    });

    expect(createSession).toHaveBeenNthCalledWith(
      1,
      {
        sessionId: "session-1",
        turns: [t2],
        model: TEST_MODEL,
        modelEffort: "high",
        botId: "bot-1",
        projectId: null,
        approvalPolicy: "unrestricted",
      },
      { signal: abortSignal }
    );

    const approval = {
      type: "tool.approval-response" as const,
      id: "call-1",
      approvalId: "ap-1",
      approved: true,
      turnId: "turn-1",
      stepId: "step-1",
      createdAt: 1,
    };

    await transport.write!.send({
      sessionId: "session-1",
      turns: [t1],
      abortSignal,
      approvals: [approval],
      payload: {
        model: TEST_MODEL,
      },
    });

    expect(createSession).toHaveBeenNthCalledWith(
      2,
      {
        sessionId: "session-1",
        turns: [],
        model: TEST_MODEL,
        approvals: [approval],
      },
      { signal: abortSignal }
    );
  });

  test("write.stop forwards keepSubagents only when true and write.inbox unwraps items", async () => {
    const stopSession = vi.fn<OrpcSessionRpc["stopSession"]>(() =>
      Promise.resolve({ ok: true } as never)
    );
    const item = {
      seq: 0,
      id: "item-1",
      sessionId: "session-1",
      kind: "user-message",
      dedupeKey: "k1",
      deliverAt: "run-boundary",
      content: userTurn("u1", "Queued"),
      payload: { model: TEST_MODEL },
      createdAt: 1,
    } satisfies InboxItem;
    const listInboxItems = vi.fn<OrpcSessionRpc["listInboxItems"]>(() =>
      Promise.resolve({ items: [item] })
    );
    const rpcClient = createFakeRpc({ stopSession, listInboxItems });
    const transport = createOrpcSessionTransport({
      rpcClient,
      queryClient: new QueryClient(),
    });

    await transport.write!.stop({ sessionId: "session-1" });
    await transport.write!.stop({
      sessionId: "session-1",
      keepSubagents: true,
    });

    expect(stopSession).toHaveBeenNthCalledWith(1, { sessionId: "session-1" });
    expect(stopSession).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      keepSubagents: true,
    });
    await expect(
      transport.write!.inbox.list({ sessionId: "session-1" })
    ).resolves.toStrictEqual([item]);
  });

  test("readOnly omits write capabilities while keeping loadTurns and openEvents", () => {
    const transport = createOrpcSessionTransport({
      rpcClient: createFakeRpc(),
      queryClient: new QueryClient(),
      readOnly: true,
    });

    expect(transport.write).toBeUndefined();
    expect(transport.loadTurns).toBeTypeOf("function");
    expect(transport.openEvents).toBeTypeOf("function");
  });
});
