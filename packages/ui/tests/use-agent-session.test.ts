import type { AgentToolSet } from "@workspace/agent";
import type {
  AgentAssistantTurn,
  AgentToolPart,
  AgentTurn,
} from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { createAgentSessionStore } from "../src/hooks/use-agent-session";

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * A held turn: one assistant step with a call waiting on the user. Cast through
 * the real union rather than restated, the same way the row tests build parts —
 * the module under test is what decides how these are read.
 */
const heldTurns = (): AgentTurn<AgentToolSet>[] =>
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
          content: [
            {
              type: "tool-bash",
              toolCallId: "call-1",
              rawInput: "",
              state: "approval-requested",
              input: {},
              approval: { id: "ap-1", createdAt: 1 },
            },
          ],
        },
      ],
    },
  ] as unknown as AgentTurn<AgentToolSet>[];

/** A stream with nothing on it, so a send settles as a request that produced
 * no events rather than one that never got a stream. */
const emptyStream = (): ReadableStream =>
  new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

/** The one held call the fixture put in the transcript, read back so a case can
 * see what the answer did to it. */
const heldPart = (
  turns: AgentTurn<AgentToolSet>[]
): AgentToolPart<AgentToolSet> => {
  const turn = turns[0] as AgentAssistantTurn<AgentToolSet>;
  return turn.content[0]!.content[0] as AgentToolPart<AgentToolSet>;
};

describe("addToolApprovalResponse", () => {
  test("answers the part on screen and sends the same answer", async () => {
    const calls: Record<string, unknown>[] = [];

    const store = createAgentSessionStore({
      id: "session-1",
      apiStream: (options) => {
        calls.push(options);
        return Promise.resolve(emptyStream());
      },
      throttleMs: 0,
      turns: heldTurns(),
      emit: () => {},
    });

    await store.addToolApprovalResponse({
      approvalId: "ap-1",
      approved: true,
      reason: "looks safe",
      payload: { model: "test-model" },
    });

    // The answer names the approval, and the caller names nothing else: the
    // turn, the step and the call are read off the transcript around it.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("test-model");
    expect(calls[0]?.approvals).toStrictEqual([
      {
        type: "tool.approval-response",
        id: "call-1",
        approvalId: "ap-1",
        approved: true,
        reason: "looks safe",
        turnId: "turn-1",
        stepId: "step-1",
        createdAt: expect.any(Number),
      },
    ]);

    // The part is answered on screen before the stream catches up, so the
    // question is gone the moment the answer is given. The rewrite is the
    // stream's own: the same fields a `tool.approval-response` event writes.
    const part = heldPart(store.getTurns());
    expect(part.state).toBe("approval-responded");
    expect(part.approval?.approved).toBe(true);
    expect(part.approval?.reason).toBe("looks safe");
  });

  test("sends nothing for a question the transcript no longer holds", async () => {
    const calls: Record<string, unknown>[] = [];

    const store = createAgentSessionStore({
      id: "session-1",
      apiStream: (options) => {
        calls.push(options);
        return Promise.resolve(emptyStream());
      },
      throttleMs: 0,
      turns: heldTurns(),
      emit: () => {},
    });

    await store.addToolApprovalResponse({
      approvalId: "ap-gone",
      approved: false,
    });

    expect(calls).toHaveLength(0);
    expect(store.getStatus()).toBe("ready");
    // Untouched: the answer named nothing, so nothing was answered.
    expect(heldPart(store.getTurns()).state).toBe("approval-requested");
  });
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
