/**
 * API server 的地址解析与健康探针。
 *
 * 刻意不 import Electron：这些是纯函数，桌面主进程和测试都能用；
 * `utilityProcess` 的生命周期在 `server-manager.ts` 里。
 */
import { resolveApiEndpoint } from "@workspace/shared/api-endpoint";

const HEALTH_TIMEOUT_MS = 1500;

/**
 * 从 `AIFY_API_HOST` / `AIFY_API_PORT` 推出默认 origin。
 *
 * 解析规则和 server、Vite 代理共用 `@workspace/shared/api-endpoint`：
 * `AIFY_API_PORT=0` 表示端口由系统分配，此时没有可探测的固定 origin，
 * 返回 undefined（调用方只能自启，或者按 attach 处理并报错）。
 */
export const defaultServerOrigin = (): string | undefined =>
  resolveApiEndpoint().origin;

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

/**
 * origin 是否落在本机回环地址上。
 *
 * 运行期切换（`aifyDesktop.useServer`）只允许回环地址：远程 server 必须由
 * 用户通过 `AIFY_API_ORIGIN` 显式配置，避免渲染端把本机令牌发给任意主机。
 */
export const isLoopbackOrigin = (value: string): boolean => {
  const { hostname } = new URL(value);

  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
};

/** 探针：确认 origin 上跑的是 Aify Zero API，而不是恰好占端口的别的服务。 */
export const isServerHealthy = async (
  origin: string,
  token: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS
): Promise<boolean> => {
  try {
    const response = await fetch(new URL("/health", origin), {
      headers: { authorization: `Bearer ${token}` },
      // A redirect from a local squatter must not turn into a probe against
      // whatever origin it points at.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
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
