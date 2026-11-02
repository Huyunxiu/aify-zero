/**
 * 应用通道的线上协议。
 *
 * 一条消息就是一个 JSON 对象，只有两个字段：`type` 定语义，`data` 带载荷。
 * 服务端和页面共用这份定义，所以两边不会各自漂移出第二套格式。
 *
 * 帧一律是 WebSocket 文本帧；二进制帧不属于这个协议。
 */

/** 应用通道上的一条消息。 */
export interface ChannelMessage {
  /** 决定这条消息怎么被理解；非空字符串。 */
  readonly type: string;
  /** 载荷；没有载荷时整个字段省略。 */
  readonly data?: unknown;
}

/** 客户端连上之后发的第一条消息。 */
export const HELLO_MESSAGE_TYPE = "hello";

/** 服务端对 `hello` 的回答。 */
export const WORLD_MESSAGE_TYPE = "world";

/** 协议不认识的 `type` 收到的回答，`data.message` 说明原因。 */
export const ERROR_MESSAGE_TYPE = "error";

/**
 * 把一条消息编成可以放进文本帧的 JSON。
 *
 * 字段顺序由这里固定，不随调用方怎么写字面量而变。
 *
 * @param message - 要发出去的消息。
 * @returns JSON 文本；`data` 缺省时不会出现在结果里。
 */
export const encodeChannelMessage = (message: ChannelMessage): string =>
  JSON.stringify({ type: message.type, data: message.data });

/**
 * 解析一条进来的文本帧。
 *
 * 校验是严格的：多一个字段就拒绝，免得两边对"协议里有什么"理解不一致。
 *
 * @param raw - 完整的 WebSocket 文本帧。
 * @returns 校验过的消息。
 * @throws {Error} 不是 JSON 对象、`type` 不合法，或出现了 type / data 之外的字段。
 */
export const parseChannelMessage = (raw: string): ChannelMessage => {
  let decoded: unknown;

  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error("ws: message is not JSON", { cause: error });
  }

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new Error("ws: message must be a JSON object");
  }

  const record = decoded as Record<string, unknown>;
  const { type } = record;

  if (typeof type !== "string" || type.length === 0) {
    throw new Error("ws: message type must be a non-empty string");
  }

  for (const key of Object.keys(record)) {
    if (key !== "type" && key !== "data") {
      throw new Error(`ws: unexpected message field "${key}"`);
    }
  }

  return "data" in record ? { data: record.data, type } : { type };
};
