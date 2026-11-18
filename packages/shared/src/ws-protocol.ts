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

/** WebSocket 的 OPEN 状态码。两端都在比较它，所以放协议里，各写一份只会漂。 */
export const WEBSOCKET_OPEN = 1;

/**
 * 桌面主进程订阅发件箱。
 *
 * 只有会弹系统通知的那条连接才发它；页面自己那条连接永远不发，因此永远不会
 * 收到通知。
 */
export const OUTBOX_SUBSCRIBE_MESSAGE_TYPE = "outbox.subscribe";

/** 服务端推给桌面的通知；`data.items` 是这一批要弹出来的发件项。 */
export const OUTBOX_NOTIFY_MESSAGE_TYPE = "outbox.notify";

/** 桌面弹完之后的回执；`data.ids` 是这些通知盖住的发件项。 */
export const OUTBOX_ACK_MESSAGE_TYPE = "outbox.ack";

/** 一次投递的内容：标题、正文，以及它指向的会话与回合。 */
export type OutboxDelivery = {
  /** 发件项 id；回执用它。 */
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** 会话标题。 */
  readonly title: string;
  /** 从回合最后一段文本截出来的正文。 */
  readonly body: string;
};

export type OutboxDeliveryData = {
  readonly items: readonly OutboxDelivery[];
};

export type OutboxAckData = {
  readonly ids: readonly string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/**
 * 校验一条 `outbox.notify` 的载荷。
 *
 * 只认这些字段：多一个、少一个都按坏帧处理。协议两端都在同一个仓库里，
 * 宽松解析只会让漂移更晚被发现。
 *
 * @param data - 消息里的 `data`。
 * @returns 校验过的载荷。
 * @throws {Error} 不是对象，或某一项形状不对。
 */
export function parseOutboxNotify(data: unknown): OutboxDeliveryData {
  if (!isRecord(data) || !Array.isArray(data.items)) {
    throw new Error("ws: outbox.notify data must hold an items array");
  }

  const items = data.items.map((item: unknown, index: number) => {
    if (!isRecord(item)) {
      throw new Error(
        `ws: outbox.notify item ${String(index)} is not an object`
      );
    }

    const { id, sessionId, turnId, title, body } = item;

    if (
      !isNonEmptyString(id) ||
      !isNonEmptyString(sessionId) ||
      !isNonEmptyString(turnId) ||
      typeof title !== "string" ||
      typeof body !== "string"
    ) {
      throw new Error(
        `ws: outbox.notify item ${String(index)} has a bad field`
      );
    }

    return { body, id, sessionId, title, turnId };
  });

  return { items };
}

/**
 * 校验一条 `outbox.ack` 的载荷。
 *
 * @param data - 消息里的 `data`。
 * @returns 校验过的载荷。
 * @throws {Error} 不是对象，或 `ids` 不是非空字符串数组。
 */
export function parseOutboxAck(data: unknown): OutboxAckData {
  if (!isRecord(data) || !Array.isArray(data.ids)) {
    throw new Error("ws: outbox.ack data must hold an ids array");
  }

  const ids = data.ids.filter(isNonEmptyString);

  if (ids.length !== data.ids.length) {
    throw new Error("ws: outbox.ack ids must all be non-empty strings");
  }

  return { ids };
}

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
