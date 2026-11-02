/**
 * WebSocket 接入层：升级、鉴权、移交。
 *
 * 只有一条路径：`/api/ws`，承载应用通道的 type / data 消息（见
 * `ws-channel.ts`）。RPC 仍然只走 HTTP 上的 `/api/rpc`。
 *
 * 凭据和 HTTP 请求逐字相同：`Authorization: Bearer <AIFY_API_TOKEN>`。
 * 浏览器的 WebSocket API 设不了请求头，所以令牌由同源代理在升级请求上注入，
 * 页面始终不持有它。
 *
 * `@hono/node-server` 的 `serve()` 返回的就是 node 的 `http.Server`，但它只
 * 为普通请求注册了监听器；升级事件由这里接管。
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  extractBearerToken,
  resolveApiToken,
  tokensEqual,
} from "@workspace/shared/api-token";
import { logger } from "@workspace/shared/logger";
import { WebSocketServer } from "ws";

import { upgradeChannel } from "./ws-channel";

/** 应用通道。 */
export const WEBSOCKET_CHANNEL_PATH = "/api/ws";

/** 通道选项。 */
export interface WebSocketOptions {
  /**
   * 每次升级解析一次令牌。默认走 `AIFY_API_TOKEN` / 令牌文件，和 HTTP
   * 中间件是同一个函数；测试注入固定值。
   */
  readonly apiToken?: () => string;
}

/**
 * 从升级请求里取凭据。
 *
 * 浏览器的 WebSocket API 设不了请求头，所以令牌由同源代理在升级请求上注入
 * ——HTTP 请求也是这么做的。
 *
 * @param request - 升级请求。
 * @param apiToken - 当前进程的令牌。
 * @returns 令牌对得上时才为 true。
 */
const isAuthorized = (
  request: IncomingMessage,
  apiToken: () => string
): boolean =>
  tokensEqual(apiToken(), extractBearerToken(request.headers.authorization));

/**
 * 手写一个 HTTP 拒绝响应。此时 socket 还没有交给 `ws`，只能自己回话。
 *
 * @param socket - 尚未升级的 TCP 连接。
 * @param status - 401 表示令牌不对；404 表示路径没有对应的协议。
 */
const rejectUpgrade = (socket: Duplex, status: 401 | 404): void => {
  const reason = status === 401 ? "Unauthorized" : "Not Found";

  socket.end(
    [
      `HTTP/1.1 ${status} ${reason}`,
      "Connection: close",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n")
  );
};

/**
 * 把应用通道挂到一个已经监听的 HTTP server 上。
 *
 * @param server - `@hono/node-server` 启动的那个 server。
 * @param options - 令牌来源；默认读进程配置。
 * @returns 关闭通道并等到所有连接退出的函数。
 */
export const attachWebSocket = (
  server: Server,
  { apiToken = resolveApiToken }: WebSocketOptions = {}
): (() => Promise<void>) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://aify.invalid");

    if (url.pathname !== WEBSOCKET_CHANNEL_PATH) {
      rejectUpgrade(socket, 404);

      return;
    }

    if (!isAuthorized(request, apiToken)) {
      rejectUpgrade(socket, 401);

      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      try {
        upgradeChannel(websocket);
      } catch (error) {
        logger.error("[ws] upgrade failed", error);
        websocket.close(1011, "upgrade failed");
      }
    });
  });

  return async () => {
    // 关闭流程里没有等待的余地：连接不主动退出就硬断，否则会拖住进程退出。
    for (const client of wss.clients) {
      client.terminate();
    }

    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error);

          return;
        }

        resolve();
      });
    });
  };
};
