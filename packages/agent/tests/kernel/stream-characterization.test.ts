import { tool } from "ai";
import type * as AiModule from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { AgentContext } from "../../src/agent-context.js";
import { AgentSession } from "../../src/agent-session.js";
import { Agent } from "../../src/agents.js";
import type { AgentStore } from "../../src/storage/index.js";
import { asTurns, userTurn } from "../compaction/fixtures.js";
import {
  script,
  stepResult,
  streamTextMock,
} from "../helpers/stream-harness.js";

// `streamText` is the only model call the loop makes; the scripted steps below
// keep this test on the turn/step machinery.
vi.mock(import("ai"), async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    streamText: vi.fn<
      typeof AiModule.streamText
    >() as unknown as typeof actual.streamText,
  };
});

const sessionRow = {
  id: "session-1",
  title: "Test session",
  metadata: {},
  projectId: null,
  kind: "main" as const,
  activeHeadId: null,
  activeStreamId: null,
  status: "idle" as const,
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  parentSessionId: null,
  parentToolCallId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** 只实现 turn 循环会碰到的写入，并把它们记下来供断言。 */
class FakeStore {
  readonly begun: unknown[] = [];
  readonly savedSteps: { stepId: string; seq: number; status: string }[] = [];
  readonly updated: { id: string; stepIds: ReadonlySet<string> }[] = [];

  getSessionById(): Promise<typeof sessionRow> {
    return Promise.resolve(sessionRow);
  }

  saveTurn(): Promise<number> {
    return Promise.resolve(1);
  }

  listInboxMessages(): Promise<never[]> {
    return Promise.resolve([]);
  }

  beginTurn({ turn }: { turn: unknown }): Promise<void> {
    this.begun.push(turn);
    return Promise.resolve();
  }

  saveStep(step: {
    stepId: string;
    seq: number;
    status: string;
  }): Promise<number> {
    this.savedSteps.push(step);
    return Promise.resolve(1);
  }

  updateTurn(
    _sessionId: string,
    id: string,
    _turn: unknown,
    { stepIds }: { stepIds?: ReadonlySet<string> } = {}
  ): Promise<number> {
    this.updated.push({ id, stepIds: stepIds ?? new Set() });
    return Promise.resolve(1);
  }
}

const asStore = (store: FakeStore): AgentStore =>
  store as unknown as AgentStore;

const makeAgent = (store: FakeStore, tools = {}): Agent =>
  new Agent({
    name: "main",
    sessionId: "session-1",
    session: new AgentSession({ turns: [] }),
    store: asStore(store),
    tools,
    context: new AgentContext({
      sessionId: "session-1",
      projectDirs: ["/tmp"],
      sessionDir: "/tmp/sessions/session-1",
      modelId: "test-model",
    }),
    apiKey: "test-key",
    apiUrl: "http://localhost",
    providerId: "test-provider",
    modelId: "test-model",
  });

const readAll = async (stream: ReadableStream): Promise<string[]> => {
  const types: string[] = [];
  const reader = stream.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    types.push((value as { type: string }).type);
  }

  return types;
};

const runTurn = async (agent: Agent, prompt: string) => {
  const finished: string[] = [];
  const stream = await agent.stream({
    turns: asTurns(userTurn("u1", prompt)),
    modelId: "test-model",
    streamId: "stream-1",
    signal: { type: "turn" },
    onFinish: (status) => {
      finished.push(status);
      return Promise.resolve();
    },
  });

  return { events: await readAll(stream), finished };
};

const echoTool = () =>
  tool({
    description: "Echoes a value.",
    inputSchema: z.object({ value: z.string() }),
    execute: ({ value }) => ({ value }),
    toModelOutput: () => ({ type: "text", value: "ok" }),
  });

describe("turn stream characterization", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
  });

  test("a text-only step ends the turn and is journaled once", async () => {
    const store = new FakeStore();
    const agent = makeAgent(store);

    script(stepResult({ text: "Hello." }));

    const { events, finished } = await runTurn(agent, "Hi.");

    expect(events).toStrictEqual([
      "turn.start",
      "step.start",
      "step.finish",
      "turn.finish",
    ]);
    expect({
      begun: store.begun.length,
      saved: store.savedSteps.map((step) => step.status),
      // 终态 header 一次，收尾回写一次。
      updated: store.updated.length,
      finished,
    }).toStrictEqual({
      begun: 1,
      saved: ["done"],
      updated: 2,
      finished: ["done"],
    });
    expect(store.updated[1]?.id).toBe((store.begun[0] as { id: string }).id);
  });

  test("a resolved tool call runs another step before the turn ends", async () => {
    const store = new FakeStore();
    const agent = makeAgent(store, { echo: echoTool() });

    script(
      stepResult({
        toolCalls: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "echo",
            input: { value: "hi" },
            providerExecuted: false,
          },
        ],
        responseMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "echo",
                input: { value: "hi" },
              },
            ],
          },
        ],
      }),
      stepResult({ text: "Done." })
    );

    const { events, finished } = await runTurn(agent, "Echo it.");

    expect(events).toStrictEqual([
      "turn.start",
      "step.start",
      "tool.result",
      "step.finish",
      "step.start",
      "step.finish",
      "turn.finish",
    ]);
    expect(store.savedSteps).toHaveLength(2);
    // 终态 header 一次，收尾回写一次。
    expect(store.updated).toHaveLength(2);
    expect(finished).toStrictEqual(["done"]);
  });
  test("declares only the tools that are not deferred", async () => {
    const agent = makeAgent(new FakeStore());
    agent.registerTool("host-tool", echoTool());
    agent.registerTool("linear__list_issues", echoTool(), "deferred");

    script(stepResult({ text: "Done." }));

    await runTurn(agent, "Say hi.");

    // 这一步交给 SDK 的工具集里没有 deferred 的那个，但它仍在工具集里。
    const call = streamTextMock.mock.calls[0]?.[0];
    expect(Object.keys(call?.tools ?? {})).toStrictEqual(["host-tool"]);
    expect(agent.tools.linear__list_issues).toBeDefined();
  });
});
