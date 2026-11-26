import type {
  AgentStreamEvent,
  AgentTurn,
  InboxItem,
} from "@workspace/agent-client";
import type * as AiModule from "ai";
import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AgentContext } from "../src/agent-context.js";
import { AgentSession } from "../src/agent-session.js";
import { Agent } from "../src/agents.js";
import { unseenImageText } from "../src/attachments/text.js";
import type { AgentInbox } from "../src/inbox/agent-inbox.js";
import type {
  ModelTarget,
  ModelTargetResolver,
} from "../src/kernel/model-gateway.js";
import type { AgentStore } from "../src/storage/index.js";
import type { SessionRecord } from "../src/storage/types.js";
import { executeToolCalls } from "../src/tools/execution.js";
import type * as ExecutionModule from "../src/tools/execution.js";
import type { AgentToolSet } from "../src/types.js";
import { asTurns, userTurn } from "./compaction/fixtures.js";
import { testModel } from "./helpers/model-target.js";
import { testSandbox } from "./helpers/sandbox.js";
import {
  script,
  stepResult,
  streamTextMock,
} from "./helpers/stream-harness.js";

// The model entry point becomes a script and the tool call a fixed result, as in the
// hook tests. This file reads only where the image sits in the request.
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

const sessionRow: SessionRecord = {
  id: "session-1",
  title: "Test session",
  metadata: {},
  botId: "default",
  projectId: null,
  kind: "main",
  activeHeadId: null,
  activeStreamId: null,
  status: "idle",
  forkedFromSessionId: null,
  forkedFromMessageId: null,
  parentSessionId: null,
  parentToolCallId: null,
  approvalPolicy: "edit",
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

class FakeStore {
  getSessionById(): Promise<SessionRecord> {
    return Promise.resolve(sessionRow);
  }

  saveTurn(): Promise<number> {
    return Promise.resolve(1);
  }

  beginTurn(): Promise<void> {
    return Promise.resolve();
  }

  saveStep(): Promise<number> {
    return Promise.resolve(1);
  }

  updateTurn(): Promise<number> {
    return Promise.resolve(1);
  }
}

class FakeInbox {
  listSteering(): Promise<InboxItem[]> {
    return Promise.resolve([]);
  }

  applySteeringSteps(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

/** One route: the connection is fixed, and the case chooses the protocol and kinds. */
const routeWith =
  (
    protocol: ModelTarget["protocol"],
    inputKinds: readonly string[]
  ): ModelTargetResolver =>
  (ref) => ({
    ref,
    name: "test-provider",
    protocol,
    baseURL: "http://127.0.0.1:1",
    apiKey: "test-key",
    inputKinds,
  });

const makeAgent = (resolveModel: ModelTargetResolver) => {
  const session = new AgentSession({ turns: [] });
  const context = new AgentContext({
    sandbox: testSandbox("/tmp", "/tmp/session-1"),
    sessionId: "session-1",
    model: testModel(),
    projectDirs: ["/tmp"],
    sessionDir: "/tmp/session-1",
  });

  return new Agent({
    approvalPolicy: "edit",
    name: "main",
    sessionId: "session-1",
    session,
    store: new FakeStore() as unknown as AgentStore,
    inbox: new FakeInbox() as unknown as AgentInbox,
    context,
    model: testModel(),
    resolveModel,
  });
};

const runTurn = async (agent: Agent, turns: AgentTurn<AgentToolSet>[]) => {
  const stream = await agent.stream({
    turns,
    model: testModel(),
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

const messagesOf = (callIndex: number): ModelMessage[] => {
  const call = streamTextMock.mock.calls[callIndex]?.[0] as
    | { messages: ModelMessage[] }
    | undefined;
  return call?.messages ?? [];
};

const toolStep = () =>
  stepResult({
    toolCalls: [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read-file",
        input: { path: "a.png" },
      },
    ],
    responseMessages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read-file",
            input: { path: "a.png" },
          },
        ],
      },
    ],
  });

const image = {
  type: "file",
  data: { type: "data", data: "AAAA" },
  mediaType: "image/png",
  filename: "a.png",
};

/** The result `read-file` produces: the envelope sentence, then the image. */
const imageResult = () => ({
  awaitingApproval: false,
  outcomes: [{}],
  toolExecutionMs: {},
  toolMessages: [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read-file",
          output: {
            type: "content",
            value: [{ type: "text", text: "<path>a.png</path>" }, image],
          },
        },
      ],
    },
  ],
});

/** Every file in a message: a user message holds them, a tool message hides them. */
const filesIn = (message: ModelMessage): unknown[] => {
  const content = message.content as {
    type: string;
    output?: { value?: { type: string }[] };
  }[];
  const found: unknown[] = [];
  for (const part of content) {
    if (part.type === "file") {
      found.push(part);
    }
    if (part.output?.value !== undefined) {
      found.push(...part.output.value.filter((item) => item.type === "file"));
    }
  }
  return found;
};

/** The parts of the single tool result in the request. */
const resultParts = (messages: ModelMessage[]): unknown[] => {
  const toolMessage = messages.find((message) => message.role === "tool");
  const [part] = (toolMessage?.content ?? []) as {
    output?: { value?: unknown[] };
  }[];
  return part?.output?.value ?? [];
};

const hasUserFile = (messages: ModelMessage[]) =>
  messages.some(
    (message) =>
      message.role === "user" &&
      (message.content as { type: string }[]).some(
        (part) => part.type === "file"
      )
  );

describe("tool result image in the request", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    executeToolCallsMock.mockReset();
  });

  test("should follow the tool message as a user message on the chat protocol", async () => {
    executeToolCallsMock.mockResolvedValue(imageResult() as never);
    script(toolStep(), stepResult({ text: "Done." }));
    const agent = makeAgent(routeWith("openai-chat", ["text", "image"]));

    await runTurn(agent, asTurns(userTurn("u1", "Look at a.png.")));

    const messages = messagesOf(1);
    const toolIndex = messages.findIndex(
      (message) => message.role === "tool" && filesIn(message).length === 0
    );
    expect(toolIndex).toBeGreaterThan(-1);
    expect(messages[toolIndex + 1]?.role).toBe("user");
    expect(filesIn(messages[toolIndex + 1]!)).toStrictEqual([image]);
  });

  test("should keep the envelope and name the call in the moved message", async () => {
    executeToolCallsMock.mockResolvedValue(imageResult() as never);
    script(toolStep(), stepResult({ text: "Done." }));
    const agent = makeAgent(routeWith("openai-chat", ["text", "image"]));

    await runTurn(agent, asTurns(userTurn("u1", "Look at a.png.")));

    const messages = messagesOf(1);
    expect(resultParts(messages)).toStrictEqual([
      { type: "text", text: "<path>a.png</path>" },
    ]);
    const moved = messages.find(
      (message) =>
        message.role === "user" &&
        filesIn(message).length > 0 &&
        (message.content as { type: string }[]).length > 1
    );
    const [lead] = (moved?.content ?? []) as { type: string; text?: string }[];
    expect(lead?.text).toContain("call-1");
  });

  test("should keep the image in the tool result on the responses protocol", async () => {
    executeToolCallsMock.mockResolvedValue(imageResult() as never);
    script(toolStep(), stepResult({ text: "Done." }));
    const agent = makeAgent(routeWith("openai-responses", ["text", "image"]));

    await runTurn(agent, asTurns(userTurn("u1", "Look at a.png.")));

    const messages = messagesOf(1);
    expect(resultParts(messages)).toStrictEqual([
      { type: "text", text: "<path>a.png</path>" },
      image,
    ]);
    expect(hasUserFile(messages)).toBeFalsy();
  });

  test("should not lift an image the model cannot read", async () => {
    executeToolCallsMock.mockResolvedValue(imageResult() as never);
    script(toolStep(), stepResult({ text: "Done." }));
    const agent = makeAgent(routeWith("openai-chat", ["text"]));

    await runTurn(agent, asTurns(userTurn("u1", "Look at a.png.")));

    const messages = messagesOf(1);
    expect(resultParts(messages)).toStrictEqual([
      { type: "text", text: "<path>a.png</path>" },
      { type: "text", text: unseenImageText("a.png", "image/png") },
    ]);
    expect(hasUserFile(messages)).toBeFalsy();
  });
});
