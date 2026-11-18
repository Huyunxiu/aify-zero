/**
 * 发件箱用例共用的现场工具。
 *
 * 桌面进程跑不进 Playwright，所以两条发件箱用例都要自己扮演桌面主进程那条
 * 连接。它们说的是同一份协议（`@workspace/shared/ws-protocol`），协议一改，
 * 它们和桌面一起红。
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "@workspace/server/routers/index";
import { frameText } from "@workspace/shared/ws-frame";
import {
  encodeChannelMessage,
  OUTBOX_NOTIFY_MESSAGE_TYPE,
  OUTBOX_SUBSCRIBE_MESSAGE_TYPE,
  parseChannelMessage,
  parseOutboxNotify,
} from "@workspace/shared/ws-protocol";
import type { OutboxDelivery } from "@workspace/shared/ws-protocol";
import NodeWebSocket from "ws";
import type { RawData } from "ws";

import type { Stack } from "./harness";

/** 竞态余量两秒加一个扫描周期；给到二十秒，坏的时候才像坏。 */
export const OUTBOX_TIMEOUT_MS = 20_000;

/** 投递器的只读状态；和 `/outbox/state` 的响应同形。 */
export type OutboxState = {
  readonly intervalMs: number;
  readonly lastScanAt: number | null;
  readonly lastSent: number;
  readonly pending: number;
  readonly pushed: number;
  readonly subscribed: boolean;
};

/**
 * 和页面同一个 RPC 客户端，只是地址和凭据换成这一场的。
 *
 * 用例要开一条会话，走的正是页面发那句话的那条路：传输、包封、错误都在
 * oRPC 里，这里不另写一套。
 */
export const rpcClient = (stack: Stack): AppRouterClient =>
  createORPCClient(
    new RPCLink({
      headers: { authorization: `Bearer ${stack.token}` },
      url: `${stack.apiUrl}/api/rpc`,
    })
  );

/** 连上应用通道并订阅；用例扮演的就是桌面主进程那一条连接。 */
export const subscribe = async (stack: Stack): Promise<NodeWebSocket> => {
  const websocket = new NodeWebSocket(
    `${stack.apiUrl.replace("http", "ws")}/api/ws`,
    { headers: { authorization: `Bearer ${stack.token}` } }
  );

  await new Promise<void>((resolve, reject) => {
    websocket.once("open", resolve);
    websocket.once("error", reject);
  });

  websocket.send(encodeChannelMessage({ type: OUTBOX_SUBSCRIBE_MESSAGE_TYPE }));

  return websocket;
};

/** 收到的通知批次，按到达顺序；断言「只推一次」要靠它。 */
export const collect = (websocket: NodeWebSocket): OutboxDelivery[][] => {
  const batches: OutboxDelivery[][] = [];

  websocket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      return;
    }

    const message = parseChannelMessage(frameText(data));

    if (message.type === OUTBOX_NOTIFY_MESSAGE_TYPE) {
      batches.push([...parseOutboxNotify(message.data).items]);
    }
  });

  return batches;
};

/** 读投递器的只读状态；排障的人走的也是这条路径。 */
export const readOutboxState = async (stack: Stack): Promise<OutboxState> => {
  const response = await fetch(`${stack.apiUrl}/api/openapi/outbox/state`, {
    headers: { authorization: `Bearer ${stack.token}` },
  });

  if (!response.ok) {
    throw new Error(
      `outbox state failed: ${String(response.status)} ${await response.text()}`
    );
  }

  return (await response.json()) as OutboxState;
};
