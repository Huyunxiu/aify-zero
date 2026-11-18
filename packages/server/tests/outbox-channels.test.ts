import { afterEach, describe, expect, test, vi } from "vitest";

import { outboxChannels } from "../src/outbox/channels";

describe("outbox channels", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("reports the earliest registration and forgets it on unsubscribe", () => {
    // 投递器拿这个时刻当「从这里起的行才算」，所以它必须是最早那条连接的时刻，
    // 而且连接走了之后要跟着回退。
    expect(outboxChannels.subscribedAt()).toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const first = outboxChannels.add(() => {});
    vi.setSystemTime(2000);
    const second = outboxChannels.add(() => {});

    expect(outboxChannels.subscribedAt()).toBe(1000);

    first();
    expect(outboxChannels.subscribedAt()).toBe(2000);

    second();
    expect(outboxChannels.subscribedAt()).toBeNull();
  });

  test("pushes to every subscriber and forwards the ack", () => {
    const batches: string[][] = [];
    const first = outboxChannels.add((items) => {
      batches.push(items.map((item) => item.id));
    });
    const second = outboxChannels.add((items) => {
      batches.push(items.map((item) => item.id));
    });
    const acked: string[][] = [];
    outboxChannels.setAckHandler((ids) => {
      acked.push([...ids]);
    });

    outboxChannels.send([
      {
        body: "done",
        id: "outbox-1",
        sessionId: "session-1",
        title: "Fix the build",
        turnId: "turn-1",
      },
    ]);
    outboxChannels.ack(["outbox-1"]);

    expect(batches).toStrictEqual([["outbox-1"], ["outbox-1"]]);
    expect(acked).toStrictEqual([["outbox-1"]]);

    first();
    second();
  });
});
