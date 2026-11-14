/**
 * 鉴权：访问令牌（机器级）或登录态（浏览器）都从这里进。
 *
 * 两条路互不影响：
 *
 * - `Authorization: Bearer <访问令牌>` —— 桌面主进程、CLI、脚本。令牌由
 *   `AIFY_API_TOKEN` 或 `~/.aify-zero/api-token` 提供。
 * - `Cookie: aify_session=<登录态令牌>` —— 浏览器。cookie 是 HttpOnly 的，
 *   页面脚本读不到；它由 `/api/auth/login` 用票据换成。
 *
 * 登录态是 cookie，浏览器会在跨站请求里自动带上它，所以走 cookie 时必须
 * 同时检查 `Origin` 和 `Sec-Fetch-Site`。访问令牌是自定义头，浏览器不会
 * 自动带，不需要这层检查。
 */
import {
  extractBearerToken,
  resolveApiToken,
  tokensEqual,
} from "@workspace/shared/api-token";
import {
  isTrustedSessionRequest,
  readSessionToken,
  resolveTrustedOrigins,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  withRequestOrigin,
} from "@workspace/shared/auth-session";
import type { AuthEnv } from "@workspace/shared/auth-session";
import type { Context, Env, MiddlewareHandler } from "hono";
import { setCookie } from "hono/cookie";

import type { AuthStore } from "./auth-store";
import { createAuthStore } from "./auth-store";

/** 一次请求证明的身份。 */
export type AuthIdentity =
  | { readonly kind: "access-token" }
  | {
      readonly kind: "session";
      readonly userId: string;
      /** 登录态令牌；退出登录要把它删掉。 */
      readonly sessionToken: string;
    };

/** 鉴权依赖；测试注入固定值。 */
export interface AuthOptions {
  /** 访问令牌解析器；默认读 `AIFY_API_TOKEN` / 令牌文件。 */
  readonly apiToken?: () => string;
  /** 登录态存储；默认用全局数据库连接。 */
  readonly authStore?: AuthStore;
  /** 来源白名单；默认从环境推导。 */
  readonly trustedOrigins?: ReadonlySet<string>;
  /** 环境变量表；测试注入。 */
  readonly env?: AuthEnv;
}

let cachedStore: AuthStore | undefined;

/** 默认存储只建一次，避免每个请求都构造一遍。 */
const defaultAuthStore = (): AuthStore => (cachedStore ??= createAuthStore());

/**
 * 解析一次请求的凭据。
 *
 * HTTP 中间件和 WebSocket 升级共用这一个函数：两条路径的验证规则必须相同，
 * 否则“能调接口但不能开通道”这种差异会很难查。
 *
 * @param headers - 请求头。
 * @param options - 依赖注入。
 * @returns 身份；两条路都不通时为 undefined。
 */
export async function resolveAuth(
  headers: { get(name: string): string | null },
  options: AuthOptions = {}
): Promise<AuthIdentity | undefined> {
  const apiToken = options.apiToken ?? resolveApiToken;
  const provided = extractBearerToken(
    headers.get("authorization") ?? undefined
  );

  if (tokensEqual(apiToken(), provided)) {
    return { kind: "access-token" };
  }

  const sessionToken = readSessionToken(headers.get("cookie") ?? undefined);

  if (sessionToken === undefined) {
    return undefined;
  }

  const store = options.authStore ?? defaultAuthStore();
  const session = await store.findSession(sessionToken);

  return session === undefined
    ? undefined
    : { kind: "session", sessionToken, userId: session.userId };
}

/**
 * 这次请求可信的来源集合：配置的名单，加上请求自身的源。
 *
 * @param requestUrl - 请求的绝对地址。
 * @param options - 依赖注入。
 */
export const sessionOrigins = (
  requestUrl: string,
  options: AuthOptions
): ReadonlySet<string> =>
  withRequestOrigin(
    options.trustedOrigins ?? resolveTrustedOrigins(options.env),
    requestUrl
  );

/**
 * 重发登录态 cookie。
 *
 * cookie 的寿命在签发时就定了，只滑动数据库行不会让浏览器跟着续期。每个
 * 带登录态的 HTTP 响应都重发一次，浏览器手里那份才一直是“从现在起 30 天”。
 * WebSocket 升级没有响应头，跳过。
 *
 * @param c - 请求上下文。
 * @param identity - 这次请求的身份。
 * @param options - 依赖注入。
 */
export const refreshSessionCookie = <E extends Env>(
  c: Context<E>,
  identity: AuthIdentity,
  options: AuthOptions
): void => {
  if (identity.kind !== "session") {
    return;
  }

  setCookie(
    c,
    SESSION_COOKIE_NAME,
    identity.sessionToken,
    sessionCookieOptions(options.env ?? process.env, c.req.url)
  );
};

/**
 * 把登录态绑到请求上下文的 `auth` 变量上。
 *
 * 401 和 403 分开：前者是没有凭据，后者是凭据有效但来源不可信。客户端据此
 * 决定是去登录还是报错。
 *
 * @param options - 依赖注入。
 */
export const authenticate =
  (options: AuthOptions = {}): MiddlewareHandler =>
  async (c, next) => {
    const identity = await resolveAuth(c.req.raw.headers, options);

    if (identity === undefined) {
      c.header("www-authenticate", 'Bearer realm="aify"');

      return c.json({ error: "unauthorized" }, 401);
    }

    if (
      identity.kind === "session" &&
      !isTrustedSessionRequest(
        c.req.raw.headers,
        sessionOrigins(c.req.url, options)
      )
    ) {
      return c.json({ error: "forbidden" }, 403);
    }

    refreshSessionCookie(c, identity, options);
    c.set("auth", identity);

    await next();
  };
