/**
 * `AIFY_API_HOST` / `AIFY_API_PORT` 的唯一解析入口。
 *
 * server（监听）、桌面主进程（探活/转发）和 Vite 配置（开发代理）都从这里
 * 取地址，避免三处各自解析导致建站和连接落到不同的主机/协议族上。
 */
import { DEFAULT_API_HOST, DEFAULT_API_PORT } from "./constants";

/** 解析后的 API 地址。 */
export interface ApiEndpoint {
  /** 传给 `serve()` 的监听主机（IPv6 字面量不带方括号）。 */
  readonly host: string;
  /** 监听端口；0 表示交给系统分配。 */
  readonly port: number;
  /** 端口是否来自显式的 `AIFY_API_PORT`，而不是默认值。 */
  readonly portExplicit: boolean;
  /** 客户端应连接的主机：通配地址和 localhost 会被收敛成回环地址。 */
  readonly connectHost: string;
  /** 客户端使用的 origin；端口为 0 时没有固定 origin。 */
  readonly origin: string | undefined;
}

/** 解析选项；默认读 `process.env`。 */
export interface ResolveApiEndpointOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly defaultHost?: string;
  readonly defaultPort?: number;
}

/**
 * 把 `host` 规范成可以交给客户端的主机名。
 *
 * - `localhost` 统一成 `127.0.0.1`：否则 `serve()` 可能只绑 IPv6，而探活
 *   走 IPv4，两边对不上。
 * - IPv6 字面量去掉方括号（`net` 的参数不带括号，URL 才带）。
 */
export function normalizeApiHost(host: string): string {
  const trimmed = host.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;

  return unbracketed.toLowerCase() === "localhost"
    ? DEFAULT_API_HOST
    : unbracketed;
}

/** 把主机和端口拼成客户端 origin；IPv6 字面量自动加方括号。 */
export function formatOrigin(host: string, port: number): string {
  const authority =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  return `http://${authority}:${String(port)}`;
}

/**
 * 解析 `AIFY_API_HOST` / `AIFY_API_PORT`。
 *
 * 非法端口在启动前就报错；`AIFY_API_PORT=0` 返回 `origin: undefined`，因为
 * 系统分配的端口在监听完成前不可知。
 */
export function resolveApiEndpoint({
  env = process.env,
  defaultHost = DEFAULT_API_HOST,
  defaultPort = DEFAULT_API_PORT,
}: ResolveApiEndpointOptions = {}): ApiEndpoint {
  const rawHost = env.AIFY_API_HOST?.trim();
  const host = normalizeApiHost(
    rawHost === undefined || rawHost === "" ? defaultHost : rawHost
  );

  const rawPort = env.AIFY_API_PORT?.trim();
  const portExplicit = rawPort !== undefined && rawPort !== "";
  const port = portExplicit ? Number(rawPort) : defaultPort;

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid AIFY_API_PORT: ${String(rawPort)}`);
  }

  const connectHost =
    host === "::" ? "::1" : host === "0.0.0.0" ? DEFAULT_API_HOST : host;

  return {
    connectHost,
    host,
    origin: port === 0 ? undefined : formatOrigin(connectHost, port),
    port,
    portExplicit,
  };
}
