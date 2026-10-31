import type {
  AgentSteeringStep,
  AgentStreamEvent,
  AgentTurn,
  InboxMessage,
} from "@workspace/agent-client";
import type { SessionModel } from "@workspace/db";
import type * as AiModule from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AgentContext } from "../src/agent-context.js";
import { AgentSession } from "../src/agent-session.js";
import { Agent } from "../src/agents.js";
import type { AgentInbox } from "../src/inbox/agent-inbox.js";
import type { AgentStore } from "../src/storage/index.js";
import { executeToolCalls } from "../src/tools/execution.js";
import type * as ExecutionModule from "../src/tools/execution.js";
import type { AgentToolSet } from "../src/types.js";
import { asTurns, userTurn } from "./compaction/fixtures.js";
import {
  script,
  stepResult,
  streamTextMock,
} from "./helpers/stream-harness.js";

// `streamText` is the only place the turn loop talks to a model. The test feeds
// it scripted steps so the loop's decision table can be exercised without a
// provider.
vi.mock(import("ai"), async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    streamText: vi.fn<
      typeof AiModule.streamText
    >() as unknown as typeof actual.streamText,
  };
});

// Tool execution is replaced for the approval case: the real one decides by
// running the tool, which is not the loop's concern here.
vi.mock(import("../src/tools/execution.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof ExecutionModule>();
  return {
    ...actual,
    executeToolCalls: vi.fn<
      typeof ExecutionModule.executeToolCalls
    >() as unknown as typeof actual.executeToolCalls,
  };
});

const executeToolCallsMock = vi.mocked(executeToolCalls);

const sessionRow: SessionModel = {
  id: "session-1",
  title: "Test session",
  metadata: {},
  projectId: null,
  kind: "main",
  activeHeadId: null,
  activeStreamId: null,
  status: "idle",
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  parentSessionId: null,
  parentToolCallId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** 只实现回合循环会碰到的方法。 */
class FakeStore {
  readonly savedSteps: unknown[] = [];
  readonly begun: unknown[] = [];
  readonly updated: { id: string; stepIds: ReadonlySet<string> }[] = [];

  getSessionById(): Promise<SessionModel> {
    return Promise.resolve(sessionRow);
  }

  saveTurn(): Promise<number> {
    return Promise.resolve(1);
  }

  setActiveHead(): Promise<number> {
    return Promise.resolve(1);
  }

  beginTurn({ turn }: { turn: unknown }): Promise<void> {
    this.begun.push(turn);
    return Promise.resolve();
  }

  saveStep(step: unknown): Promise<number> {
    this.savedSteps.push(step);
    return Promise.resolve(1);
  }

  updateTurnHeader(): Promise<number> {
    return Promise.resolve(1);
  }

  updateTurn(
    id: string,
    _turn: unknown,
    { stepIds }: { stepIds?: ReadonlySet<string> } = {}
  ): Promise<number> {
    this.updated.push({ id, stepIds: stepIds ?? new Set() });
    return Promise.resolve(1);
  }
}

/** Inbox 替身：消息只被领取一次。 */
class FakeInbox {
  messages: InboxMessage[] = [];

  listSteering(): Promise<InboxMessage[]> {
    return Promise.resolve(
      this.messages.filter((message) => message.placement === "next-step")
    );
  }

  applySteeringSteps({
    messageIds,
  }: {
    sessionId: string;
    turnId: string;
    streamId: string;
    messageIds: string[];
  }): Promise<AgentSteeringStep[]> {
    const claimed = this.messages.filter((message) =>
      messageIds.includes(message.id)
    );
    this.messages = this.messages.filter(
      (message) => !messageIds.includes(message.id)
    );

    return Promise.resolve(
      claimed.map((message) => ({
        id: message.id,
        type: "steering" as const,
        createdAt: message.createdAt,
        completedAt: message.createdAt,
        status: "done" as const,
        content: message.content.content.flatMap((step) => step.content),
      }))
    );
  }
}

const steeringMessage = (id: string, text: string): InboxMessage => ({
  seq: 0,
  id,
  sessionId: "session-1",
  requestId: id,
  placement: "next-step",
  content: userTurn(`turn-${id}`, text),
  payload: { model: "test-model" },
  createdAt: 1,
});

const makeAgent = (inbox: FakeInbox) => {
  const store = new FakeStore();
  const session = new AgentSession({ turns: [] });
  const context = new AgentContext({
    sessionId: "session-1",
    modelId: "test-model",
    projectDirs: ["/tmp"],
    sessionDir: "/tmp/session-1",
  });

  const agent = new Agent({
    name: "main",
    sessionId: "session-1",
    session,
    store: store as unknown as AgentStore,
    inbox: inbox as unknown as AgentInbox,
    context,
    apiKey: "test-key",
    apiUrl: "http://127.0.0.1:1",
    providerId: "test-provider",
    modelId: "test-model",
  });

  return { agent, store, session };
};

const runTurn = async (agent: Agent, turns: AgentTurn<AgentToolSet>[]) => {
  const stream = await agent.stream({
    turns,
    modelId: "test-model",
    streamId: "stream-1",
    signal: { type: "turn" },
    onFinish: () => Promise.resolve(),
  });

  const events: AgentStreamEvent<AgentToolSet>[] = [];
  const reader = stream.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    events.push(value);
  }

  return events;
};

const lastUserMessageText = (callIndex: number): string | undefined => {
  const call = streamTextMock.mock.calls[callIndex]?.[0] as
    | { messages?: { role: string; content: unknown }[] }
    | undefined;
  // `streamText` 拿到的是本轮历史数组的引用，后续 step 会继续往同一个数组里
  // push，所以这里按角色找最后一条 user 消息，而不是取数组末尾。
  const message = call?.messages?.findLast(
    (candidate) => candidate.role === "user"
  );
  if (message?.role !== "user" || !Array.isArray(message.content)) {
    return undefined;
  }
  const [part] = message.content as { type?: string; text?: string }[];
  return part?.type === "text" ? part.text : undefined;
};

describe("agent steering", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    executeToolCallsMock.mockReset();
    // 没有工具调用时，真实的执行器返回的就是这份空结果；这里必须显式给默认值，
    // 否则被 mock 的函数会返回 undefined。
    executeToolCallsMock.mockResolvedValue({
      awaitingApproval: false,
      outcomes: [],
      toolExecutionMs: {},
      toolMessages: [],
    } as never);
  });

  test("applies a next-step message after a text-only step and continues the turn", async () => {
    const inbox = new FakeInbox();
    inbox.messages = [steeringMessage("steer-1", "Try the other path.")];
    const { agent, session } = makeAgent(inbox);

    script(
      stepResult({ text: "First answer." }),
      stepResult({ text: "Second answer." })
    );

    const events = await runTurn(agent, asTurns(userTurn("u1", "Start.")));

    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(lastUserMessageText(1)).toBe("Try the other path.");
    expect(events.some((event) => event.type === "turn.steer")).toBeTruthy();
    // 引导消息属于同一个 assistant turn，不会开启第二个 turn。
    expect(events.filter((event) => event.type === "turn.start")).toHaveLength(
      1
    );
    expect(session.turns).toHaveLength(2);
  });

  test("does not rewrite a steering step the inbox already persisted", async () => {
    const inbox = new FakeInbox();
    inbox.messages = [steeringMessage("steer-1", "Try the other path.")];
    const { agent, store } = makeAgent(inbox);

    script(
      stepResult({ text: "First answer." }),
      stepResult({ text: "Second answer." })
    );

    await runTurn(agent, asTurns(userTurn("u1", "Start.")));

    // 引导 step 在领取消息时已经写库，assistant step 在 step.finish 时写库；
    // 回合结束只剩 turn 头部，没有 step 需要补写。
    expect(store.updated.length).toBeGreaterThan(0);
    expect(
      store.updated.every((entry) => entry.stepIds.size === 0)
    ).toBeTruthy();
  });

  test("ends the turn when no steering message is waiting", async () => {
    const inbox = new FakeInbox();
    const { agent } = makeAgent(inbox);

    script(stepResult({ text: "Only answer." }));

    const events = await runTurn(agent, asTurns(userTurn("u1", "Start.")));

    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "turn.steer")).toBeFalsy();
  });

  test("keeps steering queued when the step left an invalid tool call", async () => {
    const inbox = new FakeInbox();
    inbox.messages = [steeringMessage("steer-1", "Try the other path.")];
    const { agent } = makeAgent(inbox);

    script(
      stepResult({
        toolCalls: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: {},
            invalid: true,
          },
        ],
        responseMessages: [],
      })
    );

    const events = await runTurn(agent, asTurns(userTurn("u1", "Start.")));

    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "turn.steer")).toBeFalsy();
    expect(inbox.messages).toHaveLength(1);
  });

  test("keeps steering queued when the step is held for approval", async () => {
    const inbox = new FakeInbox();
    inbox.messages = [steeringMessage("steer-1", "Try the other path.")];
    const { agent } = makeAgent(inbox);

    executeToolCallsMock.mockResolvedValueOnce({
      awaitingApproval: true,
      outcomes: [],
      toolExecutionMs: {},
      toolMessages: [],
    } as never);

    script(
      stepResult({
        toolCalls: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: {},
          },
        ],
        responseMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "bash",
                input: {},
              },
            ],
          },
        ],
      })
    );

    const events = await runTurn(agent, asTurns(userTurn("u1", "Start.")));

    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "turn.steer")).toBeFalsy();
    expect(inbox.messages).toHaveLength(1);
  });

  test("applies steering after a tool round completes", async () => {
    const inbox = new FakeInbox();
    inbox.messages = [steeringMessage("steer-1", "Try the other path.")];
    const { agent } = makeAgent(inbox);

    executeToolCallsMock.mockResolvedValueOnce({
      awaitingApproval: false,
      outcomes: [{}],
      toolExecutionMs: {},
      toolMessages: [{ role: "tool", content: [] }],
    } as never);

    script(
      stepResult({
        toolCalls: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: {},
          },
        ],
        responseMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "bash",
                input: {},
              },
            ],
          },
        ],
      }),
      stepResult({ text: "Done." })
    );

    await runTurn(agent, asTurns(userTurn("u1", "Start.")));

    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(lastUserMessageText(1)).toBe("Try the other path.");
  });

  test("does not append a turn the assembler already holds", () => {
    const session = new AgentSession({ turns: [] });
    const turn = userTurn("u1", "Hello.");

    session.turns.push(turn);
    session.finishTurn({ turn });

    expect(session.turns).toHaveLength(1);
  });
});
