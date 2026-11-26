import type * as AiModule from "ai";
import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { unseenImageText } from "../../src/attachments/text.js";
import type {
  ModelTarget,
  ModelTargetResolver,
} from "../../src/kernel/model-gateway.js";
import { executeToolCalls } from "../../src/tools/execution.js";
import type * as ExecutionModule from "../../src/tools/execution.js";
import {
  script,
  stepResult,
  streamTextMock,
} from "../helpers/stream-harness.js";
import { FakeStore, makeAgent, runTurn } from "../helpers/turn-agent.js";

/**
 * How the two request rules compose: what the model reads decides first, and only then
 * does the protocol move what is left.
 *
 * The shape of the wire itself is not this file's claim; the chat protocol is asserted
 * against a real request in `tests/protocol/tool-result-image.test.ts`. Here the model and
 * the tool are both replaced, so a case runs in milliseconds and covers the branches the
 * wire cannot reach: a model that reads no image, and the responses protocol.
 */
vi.mock(import("ai"), async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    streamText: vi.fn<
      typeof AiModule.streamText
    >() as unknown as typeof actual.streamText,
  };
});

vi.mock(import("../../src/tools/execution.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof ExecutionModule>();
  return {
    ...actual,
    executeToolCalls: vi.fn<
      typeof ExecutionModule.executeToolCalls
    >() as unknown as typeof actual.executeToolCalls,
  };
});

const executeToolCallsMock = vi.mocked(executeToolCalls);

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

const image = {
  type: "file",
  data: { type: "data", data: "AAAA" },
  mediaType: "image/png",
  filename: "a.png",
};

const envelope = { type: "text", text: "<path>a.png</path>" };

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
          output: { type: "content", value: [envelope, image] },
        },
      ],
    },
  ],
});

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

const messagesOf = (callIndex: number): ModelMessage[] => {
  const call = streamTextMock.mock.calls[callIndex]?.[0] as
    | { messages: ModelMessage[] }
    | undefined;
  return call?.messages ?? [];
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

/** Run one turn whose scenario asks for a read, and return the next request. */
const messagesAfterTheRead = async (
  resolveModel: ModelTargetResolver
): Promise<ModelMessage[]> => {
  executeToolCallsMock.mockResolvedValue(imageResult() as never);
  script(toolStep(), stepResult({ text: "Done." }));
  const { agent } = makeAgent(new FakeStore(), { resolveModel });

  await runTurn(agent, "Look at a.png.");

  return messagesOf(1);
};

describe("images in a request", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    executeToolCallsMock.mockReset();
  });

  test("should keep the image in the tool result on the responses protocol", async () => {
    const messages = await messagesAfterTheRead(
      routeWith("openai-responses", ["text", "image"])
    );

    expect(resultParts(messages)).toStrictEqual([envelope, image]);
    expect(hasUserFile(messages)).toBeFalsy();
  });

  test("should replace the image with a sentence for a model that reads none", async () => {
    const messages = await messagesAfterTheRead(
      routeWith("openai-chat", ["text"])
    );

    expect(resultParts(messages)).toStrictEqual([
      envelope,
      { type: "text", text: unseenImageText("a.png", "image/png") },
    ]);
    expect(hasUserFile(messages)).toBeFalsy();
  });
});
