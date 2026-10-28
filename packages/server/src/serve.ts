/**
 * HTTP 入口：把 Hono `app` 绑到一个真实端口。
 *
 * `apps/server`（独立进程）和 Electron 的 `server-entry`（`utilityProcess`
 * 子进程）都只调用这里，所以监听地址解析、迁移、就绪信号和优雅退出只有
 * 一份实现。桌面壳不再 `import` 本模块——它只消费 stdout 的就绪行和
 * `GET /health`。
 */
import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { recoverInterruptedRuns } from "@workspace/agent/storage/recovery";
import { SQLiteStore } from "@workspace/agent/storage/sqlite-store";
import { closeDb, migrateDb } from "@workspace/db";
import {
  formatOrigin,
  resolveApiEndpoint,
} from "@workspace/shared/api-endpoint";
import { resolveApiToken } from "@workspace/shared/api-token";
import {
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
} from "@workspace/shared/constants";
import { logger } from "@workspace/shared/logger";

import { app } from "./app";

/** 监听地址：显式参数优先，其次环境变量，最后回落到 loopback + 18086。 */
export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

/** 启动选项。 */
export interface ServerOptions {
  /** 监听地址；默认 `AIFY_API_HOST`，再默认 `127.0.0.1`。 */
  readonly host?: string;
  /** 监听端口；默认 `AIFY_API_PORT`，再默认 18086。传 0 让系统分配。 */
  readonly port?: number;
  /**
   * 启动前是否执行数据库迁移。默认在提供了 `AIFY_MIGRATIONS_DIR` 时执行：
   * 打包后的 Electron 总会提供它，独立开发进程默认不迁移（沿用 `db:push`）。
   */
  readonly migrate?: boolean;
}

/** 已启动的 server。 */
export interface ServerHandle {
  /** 浏览器和 Electron 主进程都能访问的 origin，例如 `http://127.0.0.1:18086`。 */
  readonly origin: string;
  readonly host: string;
  /** 实际监听端口；传入 0 时是系统分配的端口。 */
  readonly port: number;
  /** 停止监听并关闭连接。可重复调用。 */
  close(): Promise<void>;
}

/** 从环境变量解析监听地址，非法端口在启动前就报错。 */
export function resolveListenAddress(): ListenAddress {
  const { host, port } = resolveApiEndpoint();

  return { host, port };
}

/**
 * 监听端口并返回可关闭的句柄。
 *
 * @param options - 监听地址与迁移开关。
 * @returns 实际监听地址和关闭函数。
 */
export async function startServer(
  options: ServerOptions = {}
): Promise<ServerHandle> {
  // Only consult the environment for the parts the caller did not supply, so an
  // explicit host/port pair is not rejected by an unrelated malformed env var.
  const resolved =
    options.host === undefined || options.port === undefined
      ? resolveApiEndpoint()
      : undefined;
  const host = options.host ?? resolved?.host ?? DEFAULT_API_HOST;
  const port = options.port ?? resolved?.port ?? DEFAULT_API_PORT;

  // Resolve the token before touching the database or the port: a missing /
  // unwritable token file should fail startup, not the first request. On a
  // fresh machine this is also what creates `~/.aify-zero/api-token`, which the
  // desktop then reads to authenticate against a standalone server.
  resolveApiToken();

  if (options.migrate ?? process.env.AIFY_MIGRATIONS_DIR !== undefined) {
    await migrateDb();
  }

  // 启动时内存里的流注册表是空的，任何 activeStreamId 都属于已经退出的进程。
  // 恢复失败不阻塞启动：开发库可能还没应用 step 迁移，下一次启动会再试。
  try {
    const recovered = await recoverInterruptedRuns(new SQLiteStore());
    if (recovered.length > 0) {
      logger.warn(
        `[startup] settled ${recovered.length} interrupted session(s)`
      );
    }
  } catch (error) {
    logger.warn("[startup] interrupted-session recovery failed", error);
  }

  const server = await new Promise<ServerType>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    const created = serve({ fetch: app.fetch, hostname: host, port }, () => {
      // The listener has done its job; keep a runtime listener below so a
      // later error is logged instead of being swallowed by a settled promise.
      created.off("error", onError);
      resolve(created);
    });

    created.once("error", onError);
  });

  server.on("error", (error) => {
    console.error("[api] server error", error);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("API server did not report a TCP address");
  }

  let closing: Promise<void> | undefined;

  return {
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        const http = server as unknown as Server;

        // SSE / 长连接会拖住 close()，先掐掉空闲和已建立的连接。
        http.closeIdleConnections();
        http.closeAllConnections();
        http.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      return closing;
    },
    host,
    origin: formatOrigin(host, address.port),
    port: address.port,
  };
}

/**
 * 作为常驻进程运行：启动、向 stdout 写一行就绪 JSON、在信号到来时关闭。
 *
 * 就绪行是 Electron 判断“子进程已经可以服务请求”的唯一信号，格式固定为
 * `{"type":"ready","origin":...}`；其余日志都是普通行。
 */
export async function runServerProcess(): Promise<void> {
  const handle = await startServer();

  process.stdout.write(
    `${JSON.stringify({
      origin: handle.origin,
      pid: process.pid,
      type: "ready",
    })}\n`
  );

  let closing: Promise<void> | undefined;
  const shutdown = (): void => {
    closing ??= handle.close().then(
      () => {
        closeDb();
        process.exit(0);
      },
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      }
    );
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
