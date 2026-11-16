import type { AgentToolSet } from "@workspace/agent";
import type {
  AgentAssistantTurn,
  AgentStaticToolPart,
  AgentTurn,
  SessionStreamEvent,
} from "@workspace/agent-client";
import { describe, expect, test, vi } from "vitest";

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

/** The one held call the fixture put in the transcript, read back so a case can
 * see what the answer did to it. */
const heldPart = (
  turns: AgentTurn<AgentToolSet>[]
): AgentStaticToolPart<AgentToolSet> => {
  const turn = turns[0] as AgentAssistantTurn<AgentToolSet>;
  return turn.content[0]!.content[0] as AgentStaticToolPart<AgentToolSet>;
};

/**
 * 会话事件流的测试替身：测试按运行发事件，和服务端发的一样。
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
    send: (event: SessionStreamEvent<AgentToolSet>) =>
      controller.enqueue(event),
    stream,
  };
};

describe("addToolApprovalResponse", () => {
  test("answers the part on screen and sends the same answer", async () => {
    const calls: Record<string, unknown>[] = [];

    const store = createAgentSessionStore({
      id: "session-1",
      apiSend: (options) => {
        calls.push(options);
        return Promise.resolve();
      },
      throttleMs: 0,
      turns: heldTurns(),
      emit: () => {},
    });

    await store.addToolApprovalResponse({
      approvalId: "ap-1",
      approved: true,
      reason: "looks safe",
      data: { scope: "session", remember: true },
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
        data: { scope: "session", remember: true },
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
    expect(part.approval).toMatchObject({
      approved: true,
      data: { scope: "session", remember: true },
    });
  });

  test("sends nothing for a question the transcript no longer holds", async () => {
    const calls: Record<string, unknown>[] = [];

    const store = createAgentSessionStore({
      id: "session-1",
      apiSend: (options) => {
        calls.push(options);
        return Promise.resolve();
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

describe("session events", () => {
  test("reads a run as one stretch of the session", async () => {
    const events = sessionEvents();

    const store = createAgentSessionStore({
      apiEvents: () => Promise.resolve(events.stream),
      apiSend: () => Promise.resolve(),
      id: "session-1",
      throttleMs: 0,
      turns: [],
      emit: () => {},
    });

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

    await vi.waitFor(() => expect(store.getStatus()).toBe("streaming"));
    expect(store.getTurns()).toHaveLength(1);

    events.send({ seq: 4, streamId: "run-1", type: "run.end" });

    await vi.waitFor(() => expect(store.getStatus()).toBe("ready"));
    expect(store.getTurns()[0]?.status).not.toBe("streaming");

    events.close();
  });

  test("a run that fails leaves the session in the error state", async () => {
    const events = sessionEvents();

    const store = createAgentSessionStore({
      apiEvents: () => Promise.resolve(events.stream),
      id: "session-1",
      throttleMs: 0,
      turns: [],
      emit: () => {},
    });

    await flush();

    events.send({ seq: 1, streamId: "run-1", type: "run.start" });
    events.send({
      failure: "model exploded",
      seq: 2,
      streamId: "run-1",
      type: "run.end",
    });

    await vi.waitFor(() => expect(store.getStatus()).toBe("error"));
    expect(store.getError()?.message).toBe("model exploded");

    events.close();
  });
});

describe("stop", () => {
  test("settles the run and tells the server, and keeps reading the session", async () => {
    const stops: { sessionId: string }[] = [];
    const events = sessionEvents();

    const store = createAgentSessionStore({
      apiEvents: () => Promise.resolve(events.stream),
      apiStop: (options) => {
        stops.push(options);
        return Promise.resolve();
      },
      id: "session-1",
      throttleMs: 0,
      turns: [],
      emit: () => {},
    });

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

    await vi.waitFor(() => expect(store.getStatus()).toBe("streaming"));

    await store.stop();

    // 屏幕先落定，不等服务端确认。
    expect(stops).toStrictEqual([{ sessionId: "session-1" }]);
    expect(store.getStatus()).toBe("ready");
    expect(store.getTurns().at(-1)?.status).toBe("aborted");

    // 停下一次运行不等于不再看这个会话：下一次运行照样读得到。
    events.send({ seq: 3, streamId: "run-2", type: "run.start" });

    await vi.waitFor(() => expect(store.getStatus()).toBe("streaming"));

    events.close();
  });

  // The server no-ops a stop for a turn that is not running, and a stop that
  // raced a server-side finish must not surface as an error either.
  test("asks the server even with nothing running, and never rejects", async () => {
    const stops: { sessionId: string }[] = [];

    const store = createAgentSessionStore({
      apiStop: (options) => {
        stops.push(options);
        return Promise.reject(new Error("no reply is running"));
      },
      id: "session-1",
      throttleMs: 0,
      turns: [],
      emit: () => {},
    });

    await store.stop();

    expect(stops).toStrictEqual([{ sessionId: "session-1" }]);
  });
});
