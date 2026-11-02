/**
 * 应用通道的端到端验证。
 *
 * 这里起一个真的 HTTP server，用真的 `ws` 客户端连上去——鉴权、升级、帧往
 * 返都在同一条路径上，没有任何替身。
 */
import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import { describe, expect, test } from "vitest";
import NodeWebSocket from "ws";

import { attachWebSocket } from "../src/ws";
import { authHeaders, TEST_API_TOKEN, testApp } from "./helpers";

interface TestServer {
  readonly origin: string;
  stop: () => Promise<void>;
}

/** 起一个只服务测试 app 的进程内 server，避开数据库和迁移。 */
const start = async (): Promise<TestServer> => {
  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>((resolve) => {
    const created = serve(
      { fetch: testApp.fetch, hostname: "127.0.0.1", port: 0 },
      (info) => {
        resolve({ port: info.port, server: created });
      }
    );
  });

  const http = server as unknown as Server;
  const closeWebSocket = attachWebSocket(http, {
    apiToken: () => TEST_API_TOKEN,
  });

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    stop: async () => {
      await closeWebSocket();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => {
          if (error) {
            reject(error);

            return;
          }

          resolve();
        });
      });
    },
  };
};

/** 升级一条连接；不带令牌时就是一次裸升级。 */
const connect = (
  origin: string,
  path: string,
  authorization?: string
): Promise<NodeWebSocket> =>
  new Promise((resolve, reject) => {
    const websocket = new NodeWebSocket(
      `${origin.replace("http", "ws")}${path}`,
      { headers: authorization === undefined ? {} : { authorization } }
    );

    websocket.once("open", () => {
      resolve(websocket);
    });
    websocket.once("error", reject);
  });

/** `ws` 交过来的帧数据可能是 Buffer、ArrayBuffer，也可能是一串 Buffer。 */
const rawText = (data: NodeWebSocket.RawData): string => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf-8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf-8");
  }

  return data.toString("utf-8");
};

/** 等下一帧并解析成 JSON。 */
const nextMessage = (websocket: NodeWebSocket): Promise<unknown> =>
  new Promise((resolve, reject) => {
    websocket.once("message", (data) => {
      try {
        resolve(JSON.parse(rawText(data)));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    websocket.once("error", reject);
  });

/** 等到连接关闭，返回关闭码。 */
const nextClose = (websocket: NodeWebSocket): Promise<number> =>
  new Promise((resolve) => {
    websocket.once("close", (code: number) => {
      resolve(code);
    });
  });

describe("websocket channel", () => {
  test("the channel answers world to hello", async () => {
    const { origin, stop } = await start();

    try {
      const websocket = await connect(
        origin,
        "/api/ws",
        authHeaders.authorization
      );

      websocket.send(JSON.stringify({ type: "hello" }));

      await expect(nextMessage(websocket)).resolves.toStrictEqual({
        type: "world",
      });

      websocket.close();
    } finally {
      await stop();
    }
  });

  test("the channel reports an unsupported type", async () => {
    const { origin, stop } = await start();

    try {
      const websocket = await connect(
        origin,
        "/api/ws",
        authHeaders.authorization
      );

      websocket.send(JSON.stringify({ type: "nope" }));

      await expect(nextMessage(websocket)).resolves.toMatchObject({
        type: "error",
      });

      websocket.close();
    } finally {
      await stop();
    }
  });

  test("the channel closes on a malformed message", async () => {
    const { origin, stop } = await start();

    try {
      const websocket = await connect(
        origin,
        "/api/ws",
        authHeaders.authorization
      );
      const closed = nextClose(websocket);

      websocket.send("not json");

      await expect(closed).resolves.toBe(1008);
    } finally {
      await stop();
    }
  });

  test("refuses an upgrade without a token", async () => {
    const { origin, stop } = await start();

    try {
      await expect(connect(origin, "/api/ws")).rejects.toThrow(/401/);
    } finally {
      await stop();
    }
  });

  test("refuses a token carried in the query string", async () => {
    const { origin, stop } = await start();

    try {
      // 凭据只认 `Authorization` 头：地址会进日志和历史记录，不能拿它带令牌。
      // 桌面壳的做法是在升级请求发出前注入这个头。
      await expect(
        connect(origin, `/api/ws?token=${TEST_API_TOKEN}`)
      ).rejects.toThrow(/401/);
    } finally {
      await stop();
    }
  });

  test("refuses a wrong token", async () => {
    const { origin, stop } = await start();

    try {
      await expect(
        connect(origin, "/api/ws", "Bearer not-the-token")
      ).rejects.toThrow(/401/);
    } finally {
      await stop();
    }
  });

  test("refuses a path without a protocol", async () => {
    const { origin, stop } = await start();

    try {
      await expect(
        connect(origin, "/api/unknown", authHeaders.authorization)
      ).rejects.toThrow(/404/);
      // RPC 走 HTTP，不在这条通道上。
      await expect(
        connect(origin, "/api/rpc/ws", authHeaders.authorization)
      ).rejects.toThrow(/404/);
    } finally {
      await stop();
    }
  });
});
