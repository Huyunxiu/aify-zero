/**
 * WebSocket 接入层：升级、鉴权、移交。
 *
 * 有两条路径：
 *
 * - `/api/ws`：应用通道的 `{ type, data }` 文本消息（见 `ws-channel.ts`）。
 * - `/api/terminal`：终端会话，二进制输入/输出加文本控制消息（见
 *   `terminal/session.ts`）。终端会启动真实 shell，所以除了 token 之外还要
 *   检查连接来自回环地址，并检查浏览器给的 `Origin`。
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
import { isAppUrl } from "@workspace/shared/app-url";
import { logger } from "@workspace/shared/logger";
import { TERMINAL_MAX_DIMENSION } from "@workspace/shared/terminal-protocol";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";

import { ApiError } from "./errors";
import { resolveSessionWorkspace } from "./routers/workspace/workspace.service";
import { spawnShellPty } from "./terminal/pty";
import type { SpawnShellPty } from "./terminal/pty";
import { acceptTerminal } from "./terminal/session";
import type { TerminalTransport } from "./terminal/session";
import { upgradeChannel } from "./ws-channel";

/** 应用通道。 */
export const WEBSOCKET_CHANNEL_PATH = "/api/ws";

/** 终端通道。 */
export const TERMINAL_WEBSOCKET_PATH = "/api/terminal";

/** 一条终端帧的上限：1 MiB 输入加 1 字节标签。 */
const TERMINAL_FRAME_LIMIT = 1024 * 1024 + 1;

/** 默认最多同时保留 8 个终端 shell。 */
const DEFAULT_MAX_TERMINAL_SESSIONS = 8;

/** `ws` 的 OPEN 状态码；只比较数字，避免在类型层引入运行时值。 */
const WEBSOCKET_OPEN = 1;

/** 终端升级选项。 */
export interface TerminalWebSocketOptions {
  /** 并发上限；测试可以调小。 */
  readonly maxSessions?: number;
  /** 会话工作目录解析；测试注入固定目录。 */
  readonly resolveCwd?: (sessionId: string) => Promise<string>;
  /** PTY 工厂；测试注入假实现。 */
  readonly spawn?: SpawnShellPty;
}

/** 通道选项。 */
export interface WebSocketOptions {
  /**
   * 每次升级解析一次令牌。默认走 `AIFY_API_TOKEN` / 令牌文件，和 HTTP
   * 中间件是同一个函数；测试注入固定值。
   */
  readonly apiToken?: () => string;
  /** 终端通道的注入点。 */
  readonly terminal?: TerminalWebSocketOptions;
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
 * @param status - 拒绝状态码。
 */
const rejectUpgrade = (socket: Duplex, status: number): void => {
  const reasons: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    429: "Too Many Requests",
    500: "Internal Server Error",
  };

  socket.end(
    [
      `HTTP/1.1 ${String(status)} ${reasons[status] ?? "Error"}`,
      "Connection: close",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n")
  );
};

/**
 * 回环地址判断。
 *
 * 终端的威胁模型比普通 API 高：拿到 token 就能启动 shell。即使 API 绑在
 * `0.0.0.0` 上，也不允许远程连接打开终端。
 *
 * @param address - `request.socket.remoteAddress`。
 * @returns 本地连接时为 true。
 */
const isLoopbackAddress = (address: string | undefined): boolean => {
  if (address === undefined) {
    return false;
  }

  return (
    address === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(address) ||
    address.startsWith("::ffff:127.")
  );
};

/**
 * 浏览器来源的主机名是不是回环。
 *
 * @param hostname - `URL.hostname`；IPv6 可能带方括号。
 * @returns `localhost`、`127.x` 或 `::1` 时为 true。
 */
const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
};

/**
 * 终端连接的来源校验。
 *
 * Vite 代理会替页面向升级请求注入 token，所以只校验 token 不够：任意网页都
 * 能借代理开一条终端。浏览器的 `Origin` 不能被脚本改写，这里只放行回环页面
 * 和桌面自己的文档源。没有 `Origin` 的客户端只可能是本机原生客户端（测试、
 * curl），已经被回环地址检查覆盖。
 *
 * @param origin - 升级请求的 `Origin`。
 * @returns 可以继续升级时为 true。
 */
const isAllowedTerminalOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined || origin === "") {
    return true;
  }

  if (isAppUrl(origin)) {
    return true;
  }

  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  return isLoopbackHostname(url.hostname);
};

/**
 * 解析一个尺寸查询参数。
 *
 * @param raw - 查询参数原值。
 * @param fallback - 缺省值。
 * @returns 合法尺寸；非法时为 `null`。
 */
const parseDimension = (
  raw: string | null,
  fallback: number
): number | null => {
  if (raw === null || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  return Number.isInteger(value) &&
    value >= 1 &&
    value <= TERMINAL_MAX_DIMENSION
    ? value
    : null;
};

/** `ws` 交过来的帧数据可能是 Buffer、ArrayBuffer，也可能是一串 Buffer。 */
const toBytes = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return data;
};

/**
 * 把 `ws` 包成会话层认识的传输接口。
 *
 * @param websocket - 已经升级的连接。
 * @returns 终端会话使用的适配器。
 */
const toTerminalTransport = (websocket: WebSocket): TerminalTransport => ({
  get bufferedAmount() {
    return websocket.bufferedAmount;
  },
  close(code: number, reason: string): void {
    websocket.close(code, reason);
  },
  onClose(listener: () => void): void {
    websocket.on("close", () => {
      listener();
    });
  },
  onMessage(listener: (data: Uint8Array, isBinary: boolean) => void): void {
    websocket.on("message", (data, isBinary) => {
      listener(toBytes(data), isBinary);
    });
  },
  send(data: Uint8Array | string): void {
    if (websocket.readyState === WEBSOCKET_OPEN) {
      websocket.send(data);
    }
  },
});

/**
 * 关闭一个已经挂好的 WebSocketServer。
 *
 * 关闭流程里没有等待的余地：连接不主动退出就硬断，否则会拖住进程退出。
 *
 * @param websocketServer - 要关闭的 server。
 */
const closeWebSocketServer = async (
  websocketServer: WebSocketServer
): Promise<void> => {
  for (const client of websocketServer.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve, reject) => {
    websocketServer.close((error) => {
      if (error) {
        reject(error);

        return;
      }

      resolve();
    });
  });
};

/**
 * 把应用通道挂到一个已经监听的 HTTP server 上。
 *
 * @param server - `@hono/node-server` 启动的那个 server。
 * @param options - 令牌来源和终端注入点；默认读进程配置。
 * @returns 关闭通道并等到所有连接退出的函数。
 */
export const attachWebSocket = (
  server: Server,
  { apiToken = resolveApiToken, terminal = {} }: WebSocketOptions = {}
): (() => Promise<void>) => {
  const channelServer = new WebSocketServer({ noServer: true });
  const terminalServer = new WebSocketServer({
    maxPayload: TERMINAL_FRAME_LIMIT,
    noServer: true,
  });
  const terminalClients = new Set<WebSocket>();
  const maxSessions = terminal.maxSessions ?? DEFAULT_MAX_TERMINAL_SESSIONS;
  const resolveCwd =
    terminal.resolveCwd ??
    (async (sessionId: string): Promise<string> => {
      const workspace = await resolveSessionWorkspace(sessionId);

      return workspace.primaryDir;
    });
  const spawn = terminal.spawn ?? spawnShellPty;

  const handleTerminalUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL
  ): Promise<void> => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      rejectUpgrade(socket, 403);

      return;
    }

    if (!isAllowedTerminalOrigin(request.headers.origin)) {
      rejectUpgrade(socket, 403);

      return;
    }

    const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";

    if (sessionId === "" || sessionId.length > 128) {
      rejectUpgrade(socket, 400);

      return;
    }

    const cols = parseDimension(url.searchParams.get("cols"), 80);
    const rows = parseDimension(url.searchParams.get("rows"), 24);

    if (cols === null || rows === null) {
      rejectUpgrade(socket, 400);

      return;
    }

    if (terminalClients.size >= maxSessions) {
      rejectUpgrade(socket, 429);

      return;
    }

    let cwd: string;

    try {
      cwd = await resolveCwd(sessionId);
    } catch (error) {
      if (error instanceof ApiError) {
        rejectUpgrade(socket, error.status === 404 ? 404 : 500);
      } else {
        logger.error("[ws] terminal workspace resolution failed", error);
        rejectUpgrade(socket, 500);
      }

      return;
    }

    if (socket.destroyed) {
      return;
    }

    terminalServer.handleUpgrade(request, socket, head, (websocket) => {
      terminalClients.add(websocket);
      websocket.once("close", () => {
        terminalClients.delete(websocket);
      });

      try {
        acceptTerminal(toTerminalTransport(websocket), {
          cols,
          cwd,
          rows,
          spawn,
        });
      } catch (error) {
        logger.error("[ws] terminal session failed", error);
        websocket.close(1011, "terminal failed");
      }
    });
  };

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://aify.invalid");

    if (url.pathname === WEBSOCKET_CHANNEL_PATH) {
      if (!isAuthorized(request, apiToken)) {
        rejectUpgrade(socket, 401);

        return;
      }

      channelServer.handleUpgrade(request, socket, head, (websocket) => {
        try {
          upgradeChannel(websocket);
        } catch (error) {
          logger.error("[ws] upgrade failed", error);
          websocket.close(1011, "upgrade failed");
        }
      });

      return;
    }

    if (url.pathname === TERMINAL_WEBSOCKET_PATH) {
      if (!isAuthorized(request, apiToken)) {
        rejectUpgrade(socket, 401);

        return;
      }

      void handleTerminalUpgrade(request, socket, head, url).catch(
        (error: unknown) => {
          logger.error("[ws] terminal upgrade failed", error);

          if (!socket.destroyed) {
            rejectUpgrade(socket, 500);
          }
        }
      );

      return;
    }

    rejectUpgrade(socket, 404);
  });

  return async () => {
    await Promise.all([
      closeWebSocketServer(channelServer),
      closeWebSocketServer(terminalServer),
    ]);
  };
};
