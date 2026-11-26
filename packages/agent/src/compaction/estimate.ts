import type { ModelMessage, ToolResultPart } from "ai";

/**
 * 粗略的 token 估算：序列化长度 / 4。
 *
 * 用来判断上下文是否需要压缩已经足够；真实数量由模型在每一步回报，
 * 有 usage 锚点时以它为准。接受任意可 JSON 序列化的值，调用方可以用同一把尺子
 * 量整个消息数组、单条消息或单个内容片段。
 */
export function estimateTokens(value: unknown): number {
  const serialized = JSON.stringify(value);
  return Math.ceil((serialized?.length ?? 0) / 4);
}

/** 原始文本的字符数转 token，不计 JSON 转义带来的额外开销。 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// 图片在 provider 侧按大致固定的成本计费，与 URL 长度无关；用常量可以避免
// 一个 data URL 把历史里其它内容的估算完全盖过去。
//
// The price is fixed because a model message does not carry the dimensions: the file
// part names only its media type. A size-aware price needs a seam that still has the
// attachment reference when it prices the request.
const IMAGE_TOKENS = 1500;
const FILE_TOKENS = 200;
const MESSAGE_OVERHEAD = 4;

type ContentPart = Exclude<ModelMessage["content"], string>[number];

/**
 * Price one tool result by what the model actually receives.
 *
 * A `content` result carries text beside files, and a file's serialized length says
 * nothing about what the provider charges for it: an image costs a fixed amount, and
 * a stored reference is a few dozen characters. Pricing the JSON would count a
 * reference as nothing and a base64 image as hundreds of thousands of tokens.
 */
function estimateToolOutputTokens(output: ToolResultPart["output"]): number {
  if (output.type === "text" || output.type === "error-text") {
    return estimateTextTokens(output.value);
  }
  if (output.type !== "content") {
    return estimateTokens(output);
  }
  let total = 0;
  for (const part of output.value) {
    if ("text" in part && typeof part.text === "string") {
      total += estimateTextTokens(part.text);
      continue;
    }
    const mediaType = "mediaType" in part ? (part.mediaType ?? "") : "";
    total += mediaType.startsWith("image/") ? IMAGE_TOKENS : FILE_TOKENS;
  }
  return total;
}

function estimatePartTokens(part: ContentPart): number {
  switch (part.type) {
    case "text":
    case "reasoning": {
      return estimateTextTokens(part.text);
    }
    case "file": {
      return part.mediaType.startsWith("image/") ? IMAGE_TOKENS : FILE_TOKENS;
    }
    case "tool-call": {
      return estimateTokens(part.input) + 8;
    }
    case "tool-result": {
      return estimateToolOutputTokens(part.output) + 8;
    }
    case "tool-approval-request":
    case "tool-approval-response": {
      return 8;
    }
    case "custom":
    case "image":
    case "reasoning-file": {
      return estimateTokens(part);
    }
    default: {
      return estimateTokens(part);
    }
  }
}

/** 单条模型消息的 token 估算，按内容片段分别计算。 */
export function estimateMessageTokens(message: ModelMessage): number {
  const { content } = message;
  const tokens =
    typeof content === "string"
      ? estimateTextTokens(content)
      : content.reduce((total, part) => total + estimatePartTokens(part), 0);

  return tokens + MESSAGE_OVERHEAD;
}

export function estimateMessagesTokens(
  messages: readonly ModelMessage[]
): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0
  );
}
