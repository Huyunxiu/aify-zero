import { z } from "zod";

/** 录制带的格式版本。读到别的版本就拒绝，不做静默降级。 */
export const TAPE_VERSION = 1;

const frameSchema = z.object({
  /** 相对本条响应开始。 */
  at: z.number().nonnegative(),
  /** base64 编码的原始字节。 */
  bytes: z.string(),
});

const inputSchema = z.object({
  type: z.enum(["user", "approval", "timer"]),
  /** 已脱敏的一句话描述，只给人看。 */
  summary: z.string(),
});

const requestSchema = z.object({
  method: z.string(),
  path: z.string(),
  stream: z.boolean(),
  model: z.string().optional(),
  /** 请求体；脱敏模式下换成摘要。 */
  body: z.string().optional(),
  bodyDigest: z.string().optional(),
  bodyBytes: z.number().nonnegative().optional(),
});

const responseSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  frames: z.array(frameSchema),
  /** 第 i 个事件在哪个帧结束。值可以重复。 */
  eventFrames: z.array(z.number().int().nonnegative()),
  /** 最后一帧到响应结束的间隔。 */
  tailMs: z.number().nonnegative(),
});

const entrySchema = z.object({
  request: requestSchema,
  response: responseSchema,
});

export const tapeItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("header"),
    version: z.number().int(),
    /** 录制开始时刻，只用于对齐日志。 */
    startedAt: z.string(),
  }),
  z.object({
    kind: z.literal("request"),
    at: z.number().nonnegative(),
    entry: entrySchema,
  }),
  z.object({
    kind: z.literal("input"),
    at: z.number().nonnegative(),
    input: inputSchema,
  }),
]);

export type TapeFrame = z.infer<typeof frameSchema>;
export type TapeInput = z.infer<typeof inputSchema>;
export type TapeRequest = z.infer<typeof requestSchema>;
export type TapeResponse = z.infer<typeof responseSchema>;
export type TapeEntry = z.infer<typeof entrySchema>;
export type TapeItem = z.infer<typeof tapeItemSchema>;
export type TapeHeader = Extract<TapeItem, { kind: "header" }>;

/** 输入事件的校验器；控制面收到请求后用它。 */
export const tapeInputSchema = inputSchema;

/**
 * 帧按 base64 存。
 *
 * 上游的 chunk 边界可能切在 UTF-8 多字节字符中间；按文本存，JSON 序列化会把
 * 坏掉的那几个字节换成 U+FFFD，回放时凑不回来。base64 对字节无损。
 */
export const encodeFrameBytes = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

/** 解码一帧，得到原始字节。 */
export const decodeFrameBytes = (encoded: string): Buffer =>
  Buffer.from(encoded, "base64");

/** 解析一行；坏行直接抛，不静默跳过。 */
export const parseTapeLine = (line: string): TapeItem =>
  tapeItemSchema.parse(JSON.parse(line));

/** 一个事件的结束标记。SSE 允许 `\r\n` 换行。 */
const EVENT_END = /\r?\n\r?\n/;

/**
 * 算出每个 SSE 事件结束在哪个帧。
 *
 * 这是索引，不是切分：原始字节始终是唯一真相。一个事件可以跨两帧，一帧也可以
 * 结束两个事件，所以结果里会出现重复的下标。
 */
export const eventFrameIndexes = (frames: readonly TapeFrame[]): number[] => {
  const indexes: number[] = [];
  // latin1 把一个字节映射成一个字符，`\n\n` 因此可以直接找。
  let carry = "";

  for (const [index, frame] of frames.entries()) {
    carry += decodeFrameBytes(frame.bytes).toString("latin1");
    let end = EVENT_END.exec(carry);
    while (end !== null) {
      indexes.push(index);
      carry = carry.slice(end.index + end[0].length);
      end = EVENT_END.exec(carry);
    }
  }

  return indexes;
};
