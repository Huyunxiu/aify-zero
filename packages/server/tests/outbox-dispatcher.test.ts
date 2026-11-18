import type { TurnRecord } from "@workspace/agent/store";
import type { OutboxDelivery } from "@workspace/shared/ws-protocol";
import { describe, expect, test, vi } from "vitest";

import type { OutboxPush } from "../src/outbox/channels";
import { OutboxDispatcher } from "../src/outbox/dispatcher";
import { deliveryBody } from "../src/outbox/snippet";
import type { OutboxCandidate, OutboxStore } from "../src/outbox/types";
import {
  OUTBOX_EXPIRE_MS,
  OUTBOX_RACE_MS,
  OUTBOX_RETENTION_MS,
} from "../src/outbox/types";

const NOW = 1_700_000_000_000;

const candidate = (
  overrides: Partial<OutboxCandidate> = {}
): OutboxCandidate => ({
  id: "outbox-1",
  sessionId: "session-1",
  title: "Fix the build",
  turnId: "turn-1",
  ...overrides,
});

const assistantTurn = (text: string) => ({
  content: [
    {
      content: [{ text, type: "text" }],
      type: "assistant",
    },
  ],
  type: "assistant",
});

/** 存储层给的是 `TurnRecord`：回合包在 `content` 里，不是裸回合。 */
const turnRecord = (turn: unknown): TurnRecord =>
  ({
    completedAt: null,
    content: turn,
    createdAt: new Date(NOW),
    detail: null,
    id: "turn-1",
    metadata: {},
    parentId: null,
    sessionId: "session-1",
    status: "done",
    type: "assistant",
    updatedAt: new Date(NOW),
  }) as TurnRecord;

type Harness = {
  store: OutboxStore;
  channels: {
    add: (push: OutboxPush) => () => void;
    hasSubscriber: () => boolean;
    send: (items: readonly OutboxDelivery[]) => void;
    setAckHandler: (handler: (ids: readonly string[]) => void) => void;
    ack: (ids: readonly string[]) => void;
  };
  sent: OutboxDelivery[][];
  delivered: string[][];
  expired: { deadline: number; now: number }[];
  pruned: number[];
  ack: (ids: readonly string[]) => void;
};

const harness = (options: {
  candidates?: OutboxCandidate[];
  turn?: unknown;
  subscribers?: number;
}): Harness => {
  const sent: OutboxDelivery[][] = [];
  const delivered: string[][] = [];
  const expired: { deadline: number; now: number }[] = [];
  const pruned: number[] = [];
  let ackHandler: ((ids: readonly string[]) => void) | undefined;
  const subscribers = options.subscribers ?? 1;

  const store: OutboxStore = {
    expireOutboxBefore: (input) => {
      expired.push(input);

      return Promise.resolve(0);
    },
    expirePendingOutbox: () => Promise.resolve(0),
    getTurnRecord: () =>
      Promise.resolve(
        turnRecord(options.turn ?? assistantTurn("the build is green"))
      ),
    listOutboxCandidates: () =>
      Promise.resolve(options.candidates ?? [candidate()]),
    markOutboxDelivered: (ids) => {
      delivered.push([...ids]);

      return Promise.resolve(ids.length);
    },
    pruneOutbox: (deadline) => {
      pruned.push(deadline);

      return Promise.resolve(0);
    },
  };

  const channels = {
    add: () => () => {},
    ack: (ids: readonly string[]) => ackHandler?.(ids),
    hasSubscriber: () => subscribers > 0,
    send: (items: readonly OutboxDelivery[]) => {
      sent.push([...items]);
    },
    setAckHandler: (handler: (ids: readonly string[]) => void) => {
      ackHandler = handler;
    },
  };

  return {
    ack: channels.ack,
    channels,
    delivered,
    expired,
    pruned,
    sent,
    store,
  };
};

const runOnce = async (
  dispatcher: OutboxDispatcher,
  until: () => boolean
): Promise<void> => {
  await dispatcher.start();
  await vi.waitFor(() => {
    expect(until()).toBeTruthy();
  });
  await dispatcher.stop();
};

describe(OutboxDispatcher, () => {
  test("pushes the last text of the turn record it read", async () => {
    const h = harness({ turn: assistantTurn("all tests pass") });
    const dispatcher = new OutboxDispatcher({
      channels: h.channels,
      now: () => NOW,
      store: h.store,
    });

    await runOnce(dispatcher, () => h.sent.length > 0);

    expect(h.sent[0]).toStrictEqual([
      {
        body: "all tests pass",
        id: "outbox-1",
        sessionId: "session-1",
        title: "Fix the build",
        turnId: "turn-1",
      },
    ]);
  });

  test("asks for candidates behind the race window", async () => {
    const h = harness({});
    const seen: { since: number; before: number }[] = [];
    h.store.listOutboxCandidates = (input) => {
      seen.push(input);

      return Promise.resolve([]);
    };
    const dispatcher = new OutboxDispatcher({
      channels: h.channels,
      now: () => NOW,
      store: h.store,
    });

    await runOnce(dispatcher, () => seen.length > 0);

    expect(seen[0]?.before).toBe(NOW - OUTBOX_RACE_MS);
    expect(seen[0]?.since).toBe(NOW);
  });

  test("expires and prunes on every sweep", async () => {
    const h = harness({});
    const dispatcher = new OutboxDispatcher({
      channels: h.channels,
      now: () => NOW,
      store: h.store,
    });

    await runOnce(dispatcher, () => h.pruned.length > 0);

    expect(h.expired[0]).toStrictEqual({
      deadline: NOW - OUTBOX_EXPIRE_MS,
      now: NOW,
    });
    expect(h.pruned[0]).toBe(NOW - OUTBOX_RETENTION_MS);
  });

  test("does nothing while nobody is subscribed", async () => {
    const h = harness({ subscribers: 0 });
    const dispatcher = new OutboxDispatcher({
      channels: h.channels,
      now: () => NOW,
      store: h.store,
    });

    await dispatcher.start();
    await Promise.resolve();
    await dispatcher.stop();

    expect(h.sent).toStrictEqual([]);
  });

  test("pushes a row once and never again", async () => {
    const h = harness({});
    const dispatcher = new OutboxDispatcher({
      channels: h.channels,
      now: () => NOW,
      store: h.store,
    });

    await dispatcher.start();
    await vi.waitFor(() => {
      expect(h.sent).toHaveLength(1);
    });
    await dispatcher.stop();
    await dispatcher.start();
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    await dispatcher.stop();

    expect(h.sent).toHaveLength(1);
  });

  test("skips a turn with no text and does not retry it", async () => {
    const h = harness({ turn: assistantTurn("   ") });
    const dispatcher = new OutboxDispatcher({
      channels: h.channels,
      now: () => NOW,
      store: h.store,
    });

    await dispatcher.start();
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    await dispatcher.stop();

    expect(h.sent).toStrictEqual([]);
  });

  test("a failed turn read keeps the rest of the batch", async () => {
    const h = harness({});
    h.store.listOutboxCandidates = () =>
      Promise.resolve([
        candidate({ id: "outbox-broken", turnId: "turn-broken" }),
        candidate({ id: "outbox-2", turnId: "turn-2" }),
      ]);
    h.store.getTurnRecord = (_sessionId, turnId) =>
      turnId === "turn-broken"
        ? Promise.reject(new Error("db is locked"))
        : Promise.resolve(turnRecord(assistantTurn("done")));
    const dispatcher = new OutboxDispatcher({
      channels: h.channels,
      now: () => NOW,
      store: h.store,
      warn: () => {},
    });

    await runOnce(dispatcher, () => h.sent.length > 0);

    expect(h.sent[0]?.map((item) => item.id)).toStrictEqual(["outbox-2"]);
  });

  test("a throwing push does not mark the rows as pushed", async () => {
    const h = harness({});
    let attempts = 0;
    h.channels.send = () => {
      attempts += 1;
      throw new Error("socket is closing");
    };
    const dispatcher = new OutboxDispatcher({
      channels: h.channels,
      now: () => NOW,
      store: h.store,
      warn: () => {},
    });

    await dispatcher.start();
    await vi.waitFor(() => {
      expect(attempts).toBeGreaterThanOrEqual(1);
    });
    await dispatcher.stop();
  });

  test("stamps a delivery when the desktop acknowledges", async () => {
    const h = harness({});
    const dispatcher = new OutboxDispatcher({
      channels: h.channels,
      now: () => NOW,
      store: h.store,
    });

    await runOnce(dispatcher, () => h.sent.length > 0);
    h.ack(["outbox-1"]);
    await vi.waitFor(() => {
      expect(h.delivered).toStrictEqual([["outbox-1"]]);
    });
  });
});

describe(deliveryBody, () => {
  test("takes the last text part of the last assistant step", () => {
    const turn = {
      content: [
        { content: [{ text: "working", type: "text" }], type: "assistant" },
        { content: [{ text: "done", type: "text" }], type: "assistant" },
      ],
      type: "assistant",
    };

    expect(deliveryBody(turn as never)).toBe("done");
  });

  test("collapses whitespace and truncates", () => {
    const turn = assistantTurn("a ".repeat(200));

    expect(deliveryBody(turn as never).length).toBeLessThanOrEqual(120);
    expect(deliveryBody(turn as never).endsWith("…")).toBeTruthy();
  });

  test("returns an empty body for a turn without text", () => {
    expect(deliveryBody({ content: [], type: "assistant" } as never)).toBe("");
    expect(deliveryBody()).toBe("");
  });
});
