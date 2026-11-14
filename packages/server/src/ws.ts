/**
 * WebSocket 接入层：升级、鉴权、移交。
 *
 * 有两条路径：
 *
 * - `/api/ws`：应用通道的 `{ type, data }` 文本消息（见 `ws-channel.ts`）。
 * - `/api/terminal`：终端会话，二进制输入/输出加文本控制消息（见
 *   `terminal/session.ts`）。终端会启动真实 shell，所以两条通道都检查
 *   浏览器给的 `Origin`；访问令牌本身已经能启动 shell，回环限制不再多加
 *   一层安全感。
 *
 * 凭据和 HTTP 请求逐字相同：桌面、CLI 用 `Authorization: Bearer
 * <访问令牌>`；浏览器带 `aify_session` cookie。升级请求里的 cookie 由浏览器
 * 自动带上，不需要代理注入。
 *
 * `@hono/node-server` 的 `serve()` 返回的就是 node 的 `http.Server`，但它只
 * 为普通请求注册了监听器；升级事件由这里接管。
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { isTrustedSessionRequest } from "@workspace/shared/auth-session";
import type { AuthEnv } from "@workspace/shared/auth-session";
import { logger } from "@workspace/shared/logger";
import { TERMINAL_MAX_DIMENSION } from "@workspace/shared/terminal-protocol";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";

import { resolveAuth, sessionOrigins } from "./auth";
import type { AuthStore } from "./auth-store";
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
   * 每次升级解析一次访问令牌。默认走 `AIFY_API_TOKEN` / 令牌文件，和 HTTP
   * 中间件是同一个函数；测试注入固定值。
   */
  readonly apiToken?: () => string;
  /** 登录态存储；浏览器用 cookie 连上来的那条路。 */
  readonly authStore?: AuthStore;
  /** 来源白名单；默认从环境推导。 */
  readonly trustedOrigins?: ReadonlySet<string>;
  /** 环境变量表；测试注入。 */
  readonly env?: AuthEnv;
  /** 终端通道的注入点。 */
  readonly terminal?: TerminalWebSocketOptions;
}

/** 一次升级鉴权的结果：通过，或者要回给客户端的 401 / 403。 */
type UpgradeAuth =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 403 };

/**
 * 把 Node 的请求头转成 fetch 的 `Headers`。
 *
 * `resolveAuth` 只认 `Headers`——HTTP 和升级两条路必须走同一个判断。
 *
 * @param request - 升级请求。
 */
const toWebHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();
  const entries = [
    ["authorization", request.headers.authorization],
    ["cookie", request.headers.cookie],
    ["origin", request.headers.origin],
    ["sec-fetch-site", request.headers["sec-fetch-site"]],
  ] as const;

  for (const [name, value] of entries) {
    if (value === undefined) {
      continue;
    }

    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  return headers;
};

/**
 * 升级请求自身的源，用于把同源连接并入白名单。
 *
 * TLS 直连时协议是 https；反代后面拿到的是 http，这时靠
 * `AIFY_PUBLIC_ORIGIN` 兜住。
 *
 * @param request - 升级请求。
 */
const requestOrigin = (request: IncomingMessage): string => {
  const { encrypted } = request.socket as Duplex & { encrypted?: boolean };
  const scheme = encrypted === true ? "https" : "http";

  return `${scheme}://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/"}`;
};

/**
 * 鉴权一次升级。
 *
 * 和 HTTP 中间件共用 `resolveAuth`：访问令牌给桌面、CLI 和脚本，登录态
 * cookie 给浏览器。两条路的规则必须一样，否则“能调接口但开不了通道”这种
 * 差异极难排查。
 *
 * @param request - 升级请求。
 * @param options - 依赖注入。
 * @returns 通过，或要回给客户端的状态码。
 */
const authorizeUpgrade = async (
  request: IncomingMessage,
  options: WebSocketOptions
): Promise<UpgradeAuth> => {
  const headers = toWebHeaders(request);
  const identity = await resolveAuth(headers, {
    apiToken: options.apiToken,
    authStore: options.authStore,
    env: options.env,
    trustedOrigins: options.trustedOrigins,
  });

  if (identity === undefined) {
    return { ok: false, status: 401 };
  }

  return isTrustedSessionRequest(
    headers,
    sessionOrigins(requestOrigin(request), options)
  )
    ? { ok: true }
    : { ok: false, status: 403 };
};

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
  options: WebSocketOptions = {}
): (() => Promise<void>) => {
  const { terminal = {} } = options;
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

    void (async () => {
      if (
        url.pathname !== WEBSOCKET_CHANNEL_PATH &&
        url.pathname !== TERMINAL_WEBSOCKET_PATH
      ) {
        rejectUpgrade(socket, 404);

        return;
      }

      const auth = await authorizeUpgrade(request, options);

      if (!auth.ok) {
        rejectUpgrade(socket, auth.status);

        return;
      }

      if (socket.destroyed) {
        return;
      }

      if (url.pathname === WEBSOCKET_CHANNEL_PATH) {
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

      await handleTerminalUpgrade(request, socket, head, url);
    })().catch((error: unknown) => {
      logger.error("[ws] upgrade failed", error);

      if (!socket.destroyed) {
        rejectUpgrade(socket, 500);
      }
    });
  });

  return async () => {
    await Promise.all([
      closeWebSocketServer(channelServer),
      closeWebSocketServer(terminalServer),
    ]);
  };
};
