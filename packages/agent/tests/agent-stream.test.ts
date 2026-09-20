import { simulateReadableStream } from "ai";
import type {
  InferToolInput,
  LanguageModelUsage,
  StepResultPerformance,
  TextStreamPart,
  ToolSet,
} from "ai";
import {
  createAsyncIterableStream,
  createNullLanguageModelUsage,
} from "ai/internal";
import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { toAgentStreamPart } from "../src/agent-stream.js";
import type { BashToolType } from "../src/tools";
import type { AgentStreamPart, AgentToolSet } from "../src/types";

const turnId = "turn-1";
const stepId = "step-1";

const performance: StepResultPerformance = {
  effectiveOutputTokensPerSecond: 1,
  outputTokensPerSecond: undefined,
  inputTokensPerSecond: undefined,
  effectiveTotalTokensPerSecond: 1,
  stepTimeMs: 1,
  responseTimeMs: 1,
  toolExecutionMs: {},
  timeToFirstOutputMs: undefined,
};

const usage: LanguageModelUsage = createNullLanguageModelUsage();

/** Runs chunks through the converter and collects everything it emits. */
async function convert<TOOLS extends ToolSet>(
  chunks: TextStreamPart<TOOLS>[]
): Promise<AgentStreamPart<TOOLS>[]> {
  const stream = createAsyncIterableStream(
    simulateReadableStream({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    })
  );

  const parts: AgentStreamPart<TOOLS>[] = [];
  for await (const part of toAgentStreamPart(turnId, stepId, stream)) {
    parts.push(part);
  }
  return parts;
}

describe(toAgentStreamPart, () => {
  test("should rename the text and reasoning parts", async () => {
    const parts = await convert<ToolSet>([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", text: "hi" },
      { type: "text-end", id: "t" },
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", text: "why" },
      { type: "reasoning-end", id: "r" },
    ]);

    expect(parts).toStrictEqual([
      { type: "text.start", id: "t" },
      { type: "text.delta", id: "t", text: "hi" },
      { type: "text.end", id: "t" },
      { type: "reasoning.start", id: "r" },
      { type: "reasoning.delta", id: "r", text: "why" },
      { type: "reasoning.end", id: "r" },
    ]);
  });

  test("should rename the tool parts", async () => {
    const call = {
      type: "tool-call",
      toolCallId: "c",
      toolName: "bash",
      input: { command: "ls" },
    } as const;

    const parts = await convert<ToolSet>([
      { type: "tool-input-start", id: "c", toolName: "bash" },
      { type: "tool-input-delta", id: "c", delta: '{"command"' },
      { type: "tool-input-end", id: "c" },
      call,
      {
        type: "tool-result",
        toolCallId: "c",
        toolName: "bash",
        input: { command: "ls" },
        output: "file.txt",
      },
      {
        type: "tool-error",
        toolCallId: "c",
        toolName: "bash",
        input: { command: "ls" },
        error: new Error("boom"),
      },
      { type: "tool-output-denied", toolCallId: "c", toolName: "bash" },
    ]);

    expect(parts.map((part) => part.type)).toStrictEqual([
      "tool.input-start",
      "tool.input-delta",
      "tool.input-end",
      "tool.call",
      "tool.result",
      "tool.error",
      "tool.output-denied",
    ]);
    expect(parts[3]).toStrictEqual({ ...call, type: "tool.call" });
  });

  test("should rename the turn and step parts, stamping the ids, without their request or response", async () => {
    const parts = await convert<ToolSet>([
      { type: "start" },
      {
        type: "start-step",
        request: { messages: [], body: { model: "test" } },
        warnings: [],
      },
      {
        type: "finish-step",
        response: { id: "resp", timestamp: new Date(0), modelId: "test" },
        usage,
        performance,
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: { anthropic: { cacheReadTokens: 7 } },
      },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: usage,
      },
    ]);

    expect(parts).toStrictEqual([
      { turnId, stepId, type: "turn.start" },
      { turnId, stepId, type: "step.start", warnings: [] },
      {
        turnId,
        stepId,
        type: "step.finish",
        usage,
        performance,
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: { anthropic: { cacheReadTokens: 7 } },
      },
      {
        turnId,
        stepId,
        type: "turn.finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: usage,
      },
    ]);
  });

  test("should drop the parts the protocol does not define", async () => {
    const parts = await convert<ToolSet>([
      { type: "custom", kind: "test.event" },
      { type: "text-delta", id: "t", text: "hi" },
      { type: "raw", rawValue: { provider: "chunk" } },
    ]);

    expect(parts).toStrictEqual([{ type: "text.delta", id: "t", text: "hi" }]);
  });

  test("should cancel the source stream when the consumer stops early", async () => {
    let cancelled = false;
    const source = createAsyncIterableStream(
      new ReadableStream<TextStreamPart<ToolSet>>({
        start(controller) {
          controller.enqueue({ type: "text-delta", id: "t", text: "hi" });
        },
        cancel() {
          cancelled = true;
        },
      })
    );

    for await (const part of toAgentStreamPart(turnId, stepId, source)) {
      expect(part.type).toBe("text.delta");
      break;
    }

    await vi.waitFor(() => {
      expect(cancelled).toBeTruthy();
    });
  });

  test("should keep the tool parts discriminated per tool", () => {
    type BashCall = Extract<
      AgentStreamPart<AgentToolSet>,
      { type: "tool.call"; toolName: "bash" }
    >;

    expectTypeOf<BashCall["input"]>().toEqualTypeOf<
      InferToolInput<BashToolType>
    >();
  });
});
