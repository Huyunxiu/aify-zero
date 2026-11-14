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
import { closeDb, migrateDb } from "@workspace/db";
import {
  formatOrigin,
  resolveApiEndpoint,
} from "@workspace/shared/api-endpoint";
import { resolveApiToken } from "@workspace/shared/api-token";
import {
  PUBLIC_ORIGIN_ENV,
  resolvePublicOrigin,
  resolveTrustedOrigins,
} from "@workspace/shared/auth-session";
import {
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
} from "@workspace/shared/constants";
import { logger } from "@workspace/shared/logger";

import { createApp } from "./app";
import { createAuthStore } from "./auth-store";
import { issueLoginLink, resolveLoginWebOrigin } from "./login-link";
import { setMcpOAuthRedirectUrl } from "./mcp/oauth";
import { shutdownMcp } from "./mcp/registry";
import { SQLiteStore } from "./storage/sqlite-store";
import { attachWebSocket } from "./ws";

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
  /**
   * 生成本次运行的登录链接。
   *
   * 票据绑定在这次进程上：重启后旧链接失效，所以每次启动都打印一条新的。
   */
  loginUrl(): Promise<string>;
}

/** 通配地址：打印链接时不能原样使用 `0.0.0.0`。 */
const isWildcardHost = (host: string): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

/** 回环地址：这些地址上的链接本机就能打开，不需要额外配置。 */
const isLoopbackHost = (host: string): boolean =>
  host === "127.0.0.1" || host === "::1" || host === "localhost";

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

  // 浏览器登录态和访问令牌共用同一套来源白名单；放进 `createApp` 和
  // `attachWebSocket`，HTTP 与升级两条路的判断才一致。
  const authStore = createAuthStore();
  const trustedOrigins = resolveTrustedOrigins();
  const app = createApp({ authStore, trustedOrigins });

  // 清掉过期的登录态和票据。表还没迁移时只告警：开发库可以用 `db:push`
  // 补上，不该因此拒绝启动。
  try {
    await authStore.pruneExpired();
  } catch (error) {
    logger.warn("[auth] session cleanup failed", error);
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

  // 升级事件由 WebSocket 通道独占：别的路径在这里就被断开，不会漏给下一个人。
  const closeWebSocket = attachWebSocket(server as unknown as Server, {
    authStore,
    trustedOrigins,
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("API server did not report a TCP address");
  }

  // 授权回调的地址只能在拿到真实端口之后确定：`AIFY_API_PORT=0` 时 listen
  // 之前没有人知道它会落在哪。
  setMcpOAuthRedirectUrl(
    `http://127.0.0.1:${address.port}/api/mcp/oauth/callback`
  );

  let closing: Promise<void> | undefined;

  const close = async (): Promise<void> => {
    const http = server as unknown as Server;

    // WebSocket 要先退干净：它自己会等连接收起，而 closeAllConnections() 是硬断。
    await closeWebSocket();
    // SSE / 长连接会拖住 close()，先掐掉空闲和已建立的连接。
    http.closeIdleConnections();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      http.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  };

  // 打印链接时用对外可达的地址。显式配置优先；否则用绑定地址——绑在某个
  // 具体网卡上时回环并不通，这时候退回 127.0.0.1 只会打印一条打不开的链接。
  // 只有绑通配地址时才无从得知该用哪个网卡，退回回环并提醒配置。
  const publicOrigin = resolvePublicOrigin();
  const printableOrigin =
    publicOrigin ??
    formatOrigin(isWildcardHost(host) ? DEFAULT_API_HOST : host, address.port);

  if (publicOrigin === undefined && !isLoopbackHost(host)) {
    logger.warn(
      `[auth] set ${PUBLIC_ORIGIN_ENV} so login links work outside this machine`
    );
  }

  return {
    close: () => {
      closing ??= close();

      return closing;
    },
    host,
    loginUrl: async () => {
      const userId = await authStore.ensureOperator();
      const link = await issueLoginLink({
        authStore,
        userId,
        webOrigin: await resolveLoginWebOrigin(printableOrigin),
      });

      return link.url;
    },
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

  // 登录链接单独一行，方便从终端里整行复制。生成失败不该阻止服务启动。
  try {
    const loginUrl = await handle.loginUrl();

    process.stdout.write(`[auth] sign in: ${loginUrl}\n`);
  } catch (error) {
    logger.warn("[auth] failed to create a login link", error);
  }

  let closing: Promise<void> | undefined;
  const shutdown = (): void => {
    closing ??= handle.close().then(
      async () => {
        // MCP 服务器可能是子进程，必须在这里收掉；进程直接退出会留下孤儿。
        await shutdownMcp();
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
