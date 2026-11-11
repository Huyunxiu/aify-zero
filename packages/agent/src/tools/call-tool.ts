import { tool } from "ai";
import { z } from "zod";

import type { AgentToolCall, CallTarget } from "./execution";
import type { ToolOutput } from "./types";

/** 转调工具的名字。执行层靠它认出哪一次调用要先解析。 */
const CALL_TOOL_NAME = "call-tool";

/** 转调的入参：真实工具名，加上它自己的入参。 */
export const callToolInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("The exact tool name, as returned by search-tools."),
  input: z
    .record(z.string(), z.unknown())
    .default({})
    .describe(
      "Arguments for that tool, matching the signature you were given."
    ),
});

export type CallToolInput = z.infer<typeof callToolInputSchema>;

/**
 * 调用一个模型看不见的工具。
 *
 * 执行层在动手之前就把这次调用换成真实的那一次，所以 hook 和审批问的是真实
 * 工具——注解在它身上。这个 `execute` 因此只在入参根本解析不出来时运行，它
 * 唯一的职责是把这件事告诉模型。
 */
function createCallTool() {
  return tool({
    description: [
      "Call a tool that is not in your list. Use the exact name from search-tools.",
      "The input must match the parameters you were given.",
      "Choose a connected service before web search or general knowledge, when the request is about it.",
    ].join("\n"),
    inputSchema: callToolInputSchema,
    execute: (input: CallToolInput): ToolOutput => {
      // 走到这里说明输入没有解析成一次真实调用，所以能说的只有「先搜」。
      throw new Error(
        `call-tool needs the exact name of a tool from search-tools; "${input.name}" was not resolved. Run search-tools first, then call the name it returns.`
      );
    },
  });
}

/**
 * 把一次 `call-tool` 调用换成它点名的那次调用。
 *
 * 其他工具的调用返回 undefined：它们按模型发出的样子执行。入参解析不出来时
 * 也返回 undefined，让模型看到 `call-tool` 自己的解释，而不是一次查找失败。
 */
export function resolveCatalogCall(
  toolCall: AgentToolCall
): CallTarget | undefined {
  if (toolCall.toolName !== CALL_TOOL_NAME) {
    return undefined;
  }

  const parsed = callToolInputSchema.safeParse(toolCall.input);
  if (!parsed.success) {
    return undefined;
  }

  return { toolName: parsed.data.name, input: parsed.data.input };
}

type CallToolToolType = ReturnType<typeof createCallTool>;

export { CALL_TOOL_NAME, createCallTool, type CallToolToolType };
