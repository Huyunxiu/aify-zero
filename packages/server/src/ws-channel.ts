import { logger } from "@workspace/shared/logger";
/**
 * 应用通道：`/api/ws` 上的 type / data 协议。
 *
 * 这里不是 RPC。每条消息就是一个 JSON 对象，`type` 决定怎么理解它；协议本身
 * 不认识调用、响应、超时这些概念，需要它们的东西应该走 `/api/rpc`。
 */
import {
  encodeChannelMessage,
  ERROR_MESSAGE_TYPE,
  HELLO_MESSAGE_TYPE,
  OUTBOX_ACK_MESSAGE_TYPE,
  OUTBOX_NOTIFY_MESSAGE_TYPE,
  OUTBOX_SUBSCRIBE_MESSAGE_TYPE,
  parseChannelMessage,
  parseOutboxAck,
  WORLD_MESSAGE_TYPE,
} from "@workspace/shared/ws-protocol";
import type { ChannelMessage } from "@workspace/shared/ws-protocol";
import type { RawData, WebSocket } from "ws";

import { outboxChannels } from "./outbox/channels";

/** `ws` 交过来的帧数据可能是 Buffer、ArrayBuffer，也可能是一串 Buffer。 */
const rawText = (data: RawData): string => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf-8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf-8");
  }

  return Buffer.from(data).toString("utf-8");
};

/** `ws` 的 OPEN 状态码；只比较数字，避免在类型层引入运行时值。 */
const OPEN = 1;

/**
 * 回答一条已经校验过的消息。
 *
 * @param websocket - 已经升级的连接。
 * @param message - 客户端发来的消息。
 */
const respond = (websocket: WebSocket, message: ChannelMessage): void => {
  if (message.type === HELLO_MESSAGE_TYPE) {
    websocket.send(encodeChannelMessage({ type: WORLD_MESSAGE_TYPE }));

    return;
  }

  logger.warn(`[ws] unsupported message type "${message.type}"`);
  websocket.send(
    encodeChannelMessage({
      data: { message: `unsupported message type "${message.type}"` },
      type: ERROR_MESSAGE_TYPE,
    })
  );
};

/**
 * 接管一条已经升级、并且已经通过鉴权的连接。
 *
 * 协议是文本帧；收到二进制帧或解析不了的 JSON 时关掉这条连接，而不是猜它的
 * 意思。
 *
 * 只有桌面主进程会发 `outbox.subscribe`：页面自己那条连接不订阅，所以永远
 * 收不到通知，也就不会出现「窗口开着和托盘里各弹一次」。
 *
 * @param websocket - 升级完成的连接。
 */
export const upgradeChannel = (websocket: WebSocket): void => {
  /** 这条连接退出时取消订阅；没订阅过就是空的。 */
  let unsubscribe: (() => void) | undefined;

  websocket.on("close", () => {
    unsubscribe?.();
    unsubscribe = undefined;
  });

  websocket.on("message", (data, isBinary) => {
    if (isBinary) {
      websocket.close(1003, "text messages required");

      return;
    }

    let message: ChannelMessage;

    try {
      message = parseChannelMessage(rawText(data));
    } catch (error) {
      // 客户端发错帧是它的错，不是服务的故障：只记一行动作，不打印调用栈。
      logger.warn(
        `[ws] invalid channel message: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      websocket.close(1008, "invalid message");

      return;
    }

    if (message.type === OUTBOX_SUBSCRIBE_MESSAGE_TYPE) {
      unsubscribe ??= outboxChannels.add((items) => {
        // 推的时候连接可能刚好在关：丢掉这一条，投递器已经记过账，不会重推。
        if (websocket.readyState !== OPEN) {
          return;
        }

        websocket.send(
          encodeChannelMessage({
            data: { items },
            type: OUTBOX_NOTIFY_MESSAGE_TYPE,
          })
        );
      });

      return;
    }

    if (message.type === OUTBOX_ACK_MESSAGE_TYPE) {
      try {
        outboxChannels.ack(parseOutboxAck(message.data).ids);
      } catch (error) {
        logger.warn(
          `[ws] invalid outbox ack: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        websocket.close(1008, "invalid message");
      }

      return;
    }

    respond(websocket, message);
  });
};
