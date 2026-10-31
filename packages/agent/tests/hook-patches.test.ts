import type {
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

// 与 steering 测试相同：把唯一的模型入口换成脚本，循环的决策不依赖网络。
vi.mock(import("ai"), async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    streamText: vi.fn<
      typeof AiModule.streamText
    >() as unknown as typeof actual.streamText,
  };
});

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

  beginTurn({ turn }: { turn: unknown }): Promise<void> {
    this.begun.push(turn);
    return Promise.resolve();
  }

  saveStep(step: unknown): Promise<number> {
    this.savedSteps.push(step);
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

/** 空的 Inbox：这些测试不关心引导消息。 */
class FakeInbox {
  listSteering(): Promise<InboxMessage[]> {
    return Promise.resolve([]);
  }

  applySteeringSteps(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

const makeAgent = () => {
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
    inbox: new FakeInbox() as unknown as AgentInbox,
    context,
    apiKey: "test-key",
    apiUrl: "http://127.0.0.1:1",
    providerId: "test-provider",
    modelId: "test-model",
  });

  return { agent, store };
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

const stepStarts = (events: AgentStreamEvent<AgentToolSet>[]) =>
  events.filter((event) => event.type === "step.start");

const instructionsOf = (callIndex: number): string | undefined => {
  const call = streamTextMock.mock.calls[callIndex]?.[0] as
    | { instructions?: string }
    | undefined;
  return call?.instructions;
};

const toolStep = () =>
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
  });

describe("start hook patches", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    executeToolCallsMock.mockReset();
    executeToolCallsMock.mockResolvedValue({
      awaitingApproval: false,
      outcomes: [{}],
      toolExecutionMs: {},
      toolMessages: [{ role: "tool", content: [] }],
    } as never);
  });

  test("turn_start can replace the model and append to the system prompt", async () => {
    const { agent } = makeAgent();
    agent.hooks.on("turn_start", (event) => ({
      modelId: `${event.modelId}-switched`,
      instructions: (prompt) => `${prompt}\n\n# Injected turn note`,
    }));

    script(stepResult({ text: "Done." }));
    const events = await runTurn(agent, asTurns(userTurn("u1", "Start.")));

    const [step] = stepStarts(events);
    expect(step).toMatchObject({
      type: "step.start",
      model: "test-model-switched",
    });
    expect(instructionsOf(0)).toBe("\n\n# Injected turn note");
  });

  test("step_start only changes the step it fired for", async () => {
    const { agent } = makeAgent();
    let assistantSteps = 0;
    agent.hooks.on("step_start", (event) => {
      if (event.stepType !== "assistant") {
        return;
      }
      assistantSteps += 1;
      return assistantSteps === 1
        ? { modelId: "step-model", instructions: "step instructions" }
        : undefined;
    });

    script(toolStep(), stepResult({ text: "Done." }));
    const events = await runTurn(agent, asTurns(userTurn("u1", "Start.")));

    const steps = stepStarts(events);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ model: "step-model" });
    expect(steps[1]).toMatchObject({ model: "test-model" });
    expect(instructionsOf(0)).toBe("step instructions");
    // 补丁没有写回 #instructions，下一步回到 turn 的默认提示。
    expect(instructionsOf(1)).toBe("");
  });

  test("merges every handler's patch in registration order", async () => {
    const { agent } = makeAgent();
    agent.hooks.on("turn_start", () => ({
      instructions: (prompt) => `${prompt}A`,
    }));
    agent.hooks.on("turn_start", () => ({
      modelId: "second-model",
      instructions: (prompt) => `${prompt}B`,
    }));

    script(stepResult({ text: "Done." }));
    const events = await runTurn(agent, asTurns(userTurn("u1", "Start.")));

    expect(stepStarts(events)[0]).toMatchObject({ model: "second-model" });
    expect(instructionsOf(0)).toBe("AB");
  });

  test("leaves the turn untouched when a handler has no opinion", async () => {
    const { agent } = makeAgent();
    agent.hooks.on("turn_start", () => {});
    agent.hooks.on("step_start", () => {});

    script(stepResult({ text: "Done." }));
    const events = await runTurn(agent, asTurns(userTurn("u1", "Start.")));

    expect(stepStarts(events)[0]).toMatchObject({ model: "test-model" });
    expect(instructionsOf(0)).toBe("");
  });

  test("keeps the turn running when a handler throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      /* keep the test output clean */
    });
    const { agent } = makeAgent();
    agent.hooks.on("turn_start", () => {
      throw new Error("boom");
    });

    script(stepResult({ text: "Done." }));
    const events = await runTurn(agent, asTurns(userTurn("u1", "Start.")));

    expect(events.some((event) => event.type === "step.finish")).toBeTruthy();
    expect(stepStarts(events)[0]).toMatchObject({ model: "test-model" });
    warn.mockRestore();
  });

  test("re-renders the turn prompt from extensions on the next turn", async () => {
    const { agent } = makeAgent();
    let turns = 0;
    agent.hooks.on("turn_start", () => {
      turns += 1;
      return turns === 1 ? { instructions: "first turn only" } : undefined;
    });

    script(stepResult({ text: "First." }), stepResult({ text: "Second." }));
    await runTurn(agent, asTurns(userTurn("u1", "Start.")));
    const second = await runTurn(agent, asTurns(userTurn("u2", "Again.")));

    expect(instructionsOf(1)).toBe("");
    expect(stepStarts(second)[0]).toMatchObject({ model: "test-model" });
  });
});
