import type { ModelMessage, ToolResultPart } from "ai";

import { NORMALIZED_MAX_PIXELS } from "../attachments/normalize";
import type { ImageDimensions } from "../utils/image-header";
import { imageDimensions } from "../utils/image-header";

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

// A provider charges for pixels, not for the encoded length: it reduces an image to
// its own detail budget and prices the result. Pricing the JSON would count one
// screenshot as tens of thousands of tokens.
//
// The size comes from the image itself. A file part still carries its bytes, so the
// head answers the question without a lookup over the history.
const IMAGE_PIXELS_PER_TOKEN = 750;
/** One tile: the smallest charge a detail rule makes for any image. */
const IMAGE_TOKENS_MIN = 85;
/**
 * The ceiling. A provider reduces an image to its detail budget before it charges for
 * it, and the budget this harness stores is the one to expect, so nothing a read keeps
 * costs more. 1.15 MP is 1536 tokens at P/750, near the 1445 an OpenAI tile rule
 * charges for the same image.
 */
const IMAGE_TOKENS_MAX = Math.ceil(
  NORMALIZED_MAX_PIXELS / IMAGE_PIXELS_PER_TOKEN
);
/** The head sizes a size read tries, in bytes: a JPEG hides its frame header. */
const IMAGE_HEAD_STEPS = [32, 4 * 1024, 64 * 1024] as const;
const FILE_TOKENS = 200;
const MESSAGE_OVERHEAD = 4;

type ContentPart = Exclude<ModelMessage["content"], string>[number];

/**
 * Read the size an image declares, from as much of its head as the format needs.
 *
 * PNG, GIF, and WebP declare the size in the first 32 bytes. A JPEG puts its frame
 * header behind the metadata segments a camera writes, so the read widens twice before
 * it gives up, and a caller whose payload is short does not pay for a slice it does not
 * have.
 * @param base64 - the image bytes, base64 encoded.
 * @returns the declared size, or undefined when no step finds one.
 */
function declaredImageSize(base64: string): ImageDimensions | undefined {
  for (const bytes of IMAGE_HEAD_STEPS) {
    const chars = Math.ceil(bytes / 3) * 4;
    const head = Buffer.from(base64.slice(0, chars), "base64");
    const size = imageDimensions(head);
    if (size !== undefined) {
      return size;
    }
    if (chars >= base64.length) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Price one image by the size its head declares.
 *
 * An image whose size no head declares takes the ceiling: over-counting makes
 * compaction early, under-counting lets the request overflow after the money is spent.
 * @param base64 - the image bytes, base64 encoded, or undefined when the part holds none.
 * @returns the tokens.
 */
function estimateImageTokens(base64: string | undefined): number {
  const size = base64 === undefined ? undefined : declaredImageSize(base64);
  const pixels = size ? size.width * size.height : NORMALIZED_MAX_PIXELS;
  const tokens = Math.ceil(pixels / IMAGE_PIXELS_PER_TOKEN);
  return Math.min(Math.max(tokens, IMAGE_TOKENS_MIN), IMAGE_TOKENS_MAX);
}

/**
 * Price one content part that carries a file.
 *
 * An image is priced by its pixels. A part that names a URL, a provider reference, or
 * a head with no readable size takes the ceiling: the estimate may be too high,
 * because a request that overflows costs more than an early compaction.
 * @param part - the content part to price.
 * @returns the tokens.
 */
function estimateFilePartTokens(part: unknown): number {
  // A tool result and a user message spell a file the same way, and the SDK names
  // their part unions differently enough that neither accepts the other.
  const file = part as { mediaType?: string; data?: unknown };
  if (!(file.mediaType ?? "").startsWith("image/")) {
    return FILE_TOKENS;
  }
  const data = file.data as { type?: string; data?: unknown } | undefined;
  return estimateImageTokens(
    data?.type === "data" && typeof data.data === "string"
      ? data.data
      : undefined
  );
}

/**
 * Price one tool result by what the model actually receives.
 *
 * A `content` result carries text beside files, and a file's serialized length says
 * nothing about what the provider charges for it: pricing the JSON would count a
 * stored reference as nothing and a base64 image as hundreds of thousands of tokens.
 * @param output - the tool result to price.
 * @returns the tokens.
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
    total += estimateFilePartTokens(part);
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
      return estimateFilePartTokens(part);
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
