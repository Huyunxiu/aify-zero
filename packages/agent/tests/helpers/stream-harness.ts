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

/**
 * 一步的假结果：流，加上循环会读的 finalStep 与 responseMessages。
 *
 * 给了 `error` 就是失败的一步：流里先给出一段文字再报这个错，`finalStep` 以
 * `finishReason: "error"` 结束，正是 `step-runner` 判失败的那条路。
 */
export const stepResult = (options: {
  text?: string;
  toolCalls?: unknown[];
  responseMessages?: unknown[];
  error?: unknown;
}) => {
  const failed = options.error !== undefined;

  return {
    stream: new ReadableStream({
      start(controller) {
        if (failed) {
          controller.enqueue({ type: "text-start", id: "text-1" });
          controller.enqueue({
            type: "text-delta",
            id: "text-1",
            text: options.text ?? "",
          });
          controller.enqueue({ type: "error", error: options.error });
        }
        controller.close();
      },
    }),
    finalStep: Promise.resolve({
      finishReason: failed ? "error" : "stop",
      rawFinishReason: failed ? "error" : "stop",
      usage: usage(),
      toolCalls: options.toolCalls ?? [],
      providerMetadata: undefined,
      performance: { toolExecutionMs: {} },
    }),
    responseMessages: Promise.resolve(
      failed
        ? []
        : (options.responseMessages ?? [
            {
              role: "assistant",
              content: [{ type: "text", text: options.text ?? "" }],
            },
          ])
    ),
  };
};

/** 按顺序把每一步的结果交给下一次 `streamText` 调用。 */
export const script = (...steps: ReturnType<typeof stepResult>[]): void => {
  for (const step of steps) {
    streamTextMock.mockReturnValueOnce(step as never);
  }
};
