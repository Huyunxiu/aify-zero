import type { OutboxNotification } from "@workspace/shared/ws-protocol";
import { describe, expect, test, vi } from "vitest";

import type { OutboxPush } from "../src/outbox/channels";
import { OutboxDispatcher } from "../src/outbox/dispatcher";
import { notificationBody } from "../src/outbox/snippet";
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

type Harness = {
  store: OutboxStore;
  channels: {
    add: (push: OutboxPush) => () => void;
    hasSubscriber: () => boolean;
    send: (items: readonly OutboxNotification[]) => void;
    setAckHandler: (handler: (ids: readonly string[]) => void) => void;
    ack: (ids: readonly string[]) => void;
  };
  sent: OutboxNotification[][];
  delivered: string[][];
  expired: number[];
  pruned: number[];
  ack: (ids: readonly string[]) => void;
};

const harness = (options: {
  candidates?: OutboxCandidate[];
  turn?: unknown;
  subscribers?: number;
}): Harness => {
  const sent: OutboxNotification[][] = [];
  const delivered: string[][] = [];
  const expired: number[] = [];
  const pruned: number[] = [];
  let ackHandler: ((ids: readonly string[]) => void) | undefined;
  const subscribers = options.subscribers ?? 1;

  const store: OutboxStore = {
    expireOutboxBefore: (deadline) => {
      expired.push(deadline);

      return Promise.resolve(0);
    },
    expirePendingOutbox: () => Promise.resolve(0),
    getTurnRecord: () =>
      Promise.resolve(options.turn ?? assistantTurn("the build is green")),
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
    recordOutboxTurn: () => Promise.resolve(),
  };

  const channels = {
    add: () => () => {},
    ack: (ids: readonly string[]) => ackHandler?.(ids),
    hasSubscriber: () => subscribers > 0,
    send: (items: readonly OutboxNotification[]) => {
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
  test("pushes a candidate with the last text of its turn", async () => {
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

    expect(h.expired[0]).toBe(NOW - OUTBOX_EXPIRE_MS);
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
    // 再扫一次：同一行还在候选里（没人回执），但已经推过。
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

describe(notificationBody, () => {
  test("takes the last text part of the last assistant step", () => {
    const turn = {
      content: [
        { content: [{ text: "working", type: "text" }], type: "assistant" },
        { content: [{ text: "done", type: "text" }], type: "assistant" },
      ],
      type: "assistant",
    };

    expect(notificationBody(turn)).toBe("done");
  });

  test("collapses whitespace and truncates", () => {
    const turn = assistantTurn("a ".repeat(200));

    expect(notificationBody(turn).length).toBeLessThanOrEqual(120);
    expect(notificationBody(turn).endsWith("…")).toBeTruthy();
  });

  test("returns an empty body for a turn without text", () => {
    expect(notificationBody({ content: [], type: "assistant" })).toBe("");
    expect(notificationBody()).toBe("");
  });
});
