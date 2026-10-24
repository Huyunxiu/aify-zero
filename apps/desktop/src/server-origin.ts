/**
 * API server 的地址解析与健康探针。
 *
 * 刻意不 import Electron：这些是纯函数，桌面主进程和测试都能用；
 * `utilityProcess` 的生命周期在 `server-manager.ts` 里。
 */
import { DEFAULT_API_PORT } from "@workspace/shared/constants";

const HEALTH_TIMEOUT_MS = 1500;

/**
 * 从 `AIFY_API_HOST` / `AIFY_API_PORT` 推出默认 origin。
 *
 * `AIFY_API_PORT=0` 表示端口由系统分配，此时没有可探测的固定 origin，
 * 返回 undefined（调用方只能自启，或者按 attach 处理并报错）。
 */
export const defaultServerOrigin = (): string | undefined => {
  const host = process.env.AIFY_API_HOST ?? "127.0.0.1";
  const rawPort = process.env.AIFY_API_PORT;
  const port =
    rawPort === undefined || rawPort === ""
      ? DEFAULT_API_PORT
      : Number(rawPort);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid AIFY_API_PORT: ${String(rawPort)}`);
  }
  if (port === 0) {
    return undefined;
  }

  const authority =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  return `http://${authority}:${String(port)}`;
};

/**
 * 校验并规范化用户给出的 origin。只接受 http(s)：转发层只会向这两种
 * 协议发请求，别的 scheme 说明配置写错了。
 */
export const normalizeServerOrigin = (value: string): string => {
  const url = new URL(value);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`API server origin must be http(s), got ${value}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("API server origin must not carry credentials");
  }

  return url.origin;
};

/** 探针：确认 origin 上跑的是 Aify Zero API，而不是恰好占端口的别的服务。 */
export const isServerHealthy = async (origin: string): Promise<boolean> => {
  try {
    const response = await fetch(new URL("/health", origin), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return false;
    }

    const body: unknown = await response.json();

    return (
      typeof body === "object" &&
      body !== null &&
      (body as { ok?: unknown }).ok === true
    );
  } catch {
    return false;
  }
};
