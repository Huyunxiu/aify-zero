import { streamText } from "ai";
import { vi } from "vitest";

/**
 * `streamText` 是 turn 循环与模型之间的唯一入口。测试文件用
 * `vi.mock(import("ai"), ...)` 把它换成脚本；这里取得的引用就是那份 mock。
 */
export const streamTextMock = vi.mocked(streamText);

export const usage = (inputTokens = 10) => ({
  inputTokens,
  inputTokenDetails: {
    noCacheTokens: inputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 5,
  outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
  totalTokens: inputTokens + 5,
});

/** 一步的假结果：空的流，加上循环会读的 finalStep 与 responseMessages。 */
export const stepResult = (options: {
  text?: string;
  toolCalls?: unknown[];
  responseMessages?: unknown[];
}) => ({
  stream: new ReadableStream({
    start(controller) {
      controller.close();
    },
  }),
  finalStep: Promise.resolve({
    finishReason: "stop",
    rawFinishReason: "stop",
    usage: usage(),
    toolCalls: options.toolCalls ?? [],
    providerMetadata: undefined,
    performance: { toolExecutionMs: {} },
  }),
  responseMessages: Promise.resolve(
    options.responseMessages ?? [
      {
        role: "assistant",
        content: [{ type: "text", text: options.text ?? "" }],
      },
    ]
  ),
});

/** 按顺序把每一步的结果交给下一次 `streamText` 调用。 */
export const script = (...steps: ReturnType<typeof stepResult>[]): void => {
  for (const step of steps) {
    streamTextMock.mockReturnValueOnce(step as never);
  }
};
