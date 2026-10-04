import { describe, expect, test } from "vitest";

import { createAgentSessionStore } from "../src/hooks/use-agent-session";

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * A stream that emits one `turn.start` and then hangs until it is aborted — the
 * shape of a turn still being produced when the user stops it.
 */
const pendingTurnStream = (abortSignal: AbortSignal): ReadableStream =>
  new ReadableStream({
    start(controller) {
      controller.enqueue({
        type: "turn.start",
        id: "turn-1",
        turnType: "assistant",
        createdAt: Date.now(),
      });
      abortSignal.addEventListener("abort", () => {
        controller.error(new DOMException("Aborted", "AbortError"));
      });
    },
  });

describe("stop", () => {
  test("aborts the local read, tells the server, and settles the turn", async () => {
    const stops: { sessionId: string }[] = [];

    const store = createAgentSessionStore({
      id: "session-1",
      apiStream: ({ abortSignal }) =>
        Promise.resolve(pendingTurnStream(abortSignal)),
      apiStop: (options) => {
        stops.push(options);
        return Promise.resolve();
      },
      throttleMs: 0,
      turns: [],
      emit: () => {},
    });

    const send = store.sendTurns({
      turns: [],
      abortSignal: new AbortController().signal,
    });

    await flush();
    expect(store.getStatus()).toBe("streaming");

    await store.stop();
    await send;

    expect(stops).toStrictEqual([{ sessionId: "session-1" }]);
    expect(store.getTurns().at(-1)?.status).toBe("aborted");
    expect(store.getStatus()).toBe("ready");
  });

  // The server no-ops a stop for a turn that is not running, and a stop that
  // raced a server-side finish must not surface as an error either.
  test("asks the server even with nothing running, and never rejects", async () => {
    const stops: { sessionId: string }[] = [];

    const store = createAgentSessionStore({
      id: "session-1",
      apiStop: (options) => {
        stops.push(options);
        return Promise.reject(new Error("no reply is running"));
      },
      throttleMs: 0,
      turns: [],
      emit: () => {},
    });

    await store.stop();

    expect(stops).toStrictEqual([{ sessionId: "session-1" }]);
  });
});
