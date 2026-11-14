/**
 * 浏览器登录态的共享定义：cookie 名、时长、来源白名单和链接拼装。
 *
 * 这里只有纯函数，不读数据库、不读文件，浏览器和 server 都能引用。登录态
 * 的签发与校验在 server 侧（`packages/server/src/auth-store.ts`）。
 *
 * 术语见 `packages/server/GLOSSARY.md`：登录态是浏览器证明自己身份的那段
 * 凭据；登录票据是一次性、短时的入口；访问令牌是机器级凭据，只给桌面、
 * CLI 和脚本用。三者不是一回事。
 */
import { formatOrigin } from "./api-endpoint";
import { APP_ORIGIN } from "./app-url";
import {
  DEFAULT_WEB_PORT,
  SIGN_IN_TOKEN_PARAM,
  WEB_PORT_ENV,
} from "./constants";

/** 对外可达的源，例如 `https://aify.example.com`。用于打印链接和 Secure cookie。 */
export const PUBLIC_ORIGIN_ENV = "AIFY_PUBLIC_ORIGIN";

/** web 文档的源；开发期是 Vite，生产期缺省等于 server 自己。 */
export const WEB_ORIGIN_ENV = "AIFY_WEB_ORIGIN";

/** `apps/web/dist` 的位置；不设时按仓库布局推断。 */
export const WEB_ROOT_ENV = "AIFY_WEB_ROOT";

/** 浏览器携带登录态的 cookie 名。 */
export const SESSION_COOKIE_NAME = "aify_session";

/** 登录态的有效期；使用中按 {@link AUTH_SESSION_REFRESH_MS} 滑动续期。 */
export const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 距上次使用超过这个时长才续期，避免每个请求都写一次库。 */
export const AUTH_SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;

/** 环境变量表；测试可以传自己的对象。 */
export type AuthEnv = Readonly<Record<string, string | undefined>>;

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * 把一个环境变量解析成规范的源。
 *
 * 只接受裸的 `scheme://host[:port]`：带路径或查询的地址会让 cookie 的作用域
 * 和链接拼装产生歧义，宁可在启动时报错。
 *
 * @param raw - 环境变量原值。
 * @param name - 变量名，用于错误信息。
 * @returns 规范的源，例如 `https://aify.example.com`。
 */
const parseOrigin = (raw: string, name: string): string => {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute origin such as https://host`);
  }

  if (
    !HTTP_PROTOCOLS.has(url.protocol) ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(
      `${name} must be a bare origin without path or credentials`
    );
  }

  return url.origin;
};

const readEnv = (env: AuthEnv, name: string): string | undefined => {
  const raw = env[name]?.trim();

  return raw === undefined || raw === "" ? undefined : raw;
};

/** 对外可达的源；没有显式配置时为 undefined。 */
export function resolvePublicOrigin(env: AuthEnv = process.env) {
  const raw = readEnv(env, PUBLIC_ORIGIN_ENV);

  return raw === undefined ? undefined : parseOrigin(raw, PUBLIC_ORIGIN_ENV);
}

/** web 文档的源；没有显式配置时为 undefined。 */
export function resolveWebOrigin(env: AuthEnv = process.env) {
  const raw = readEnv(env, WEB_ORIGIN_ENV);

  return raw === undefined ? undefined : parseOrigin(raw, WEB_ORIGIN_ENV);
}

/**
 * 开发期 Vite 的源。
 *
 * 和 `apps/web/vite.shared.ts` 读同一个端口变量；两个进程都从环境拿，谁也
 * 不用猜对方落在哪个端口。
 */
export function resolveDevWebOrigin(env: AuthEnv = process.env): string {
  const raw = readEnv(env, WEB_PORT_ENV);
  const port = raw === undefined ? DEFAULT_WEB_PORT : Number(raw);

  return formatOrigin(
    "127.0.0.1",
    Number.isInteger(port) && port > 0 ? port : DEFAULT_WEB_PORT
  );
}

/**
 * 允许携带登录态的源（来源白名单）。
 *
 * 桌面的 `aify-app://app` 和开发期 Vite 永远在名单里；显式配置的公网源和
 * web 源再加进来。请求自身的源在中间件里临时并入——cookie 按主机名存放，
 * 别的站点拿不到它，所以 Host 推导不出新的权限。
 */
export function resolveTrustedOrigins(
  env: AuthEnv = process.env
): ReadonlySet<string> {
  const allowed = new Set<string>([APP_ORIGIN, resolveDevWebOrigin(env)]);
  const webOrigin = resolveWebOrigin(env);
  const publicOrigin = resolvePublicOrigin(env);

  if (webOrigin !== undefined) {
    allowed.add(webOrigin);
  }

  if (publicOrigin !== undefined) {
    allowed.add(publicOrigin);
  }

  return allowed;
}

/**
 * 从 `Cookie` 头里取出一个值。
 *
 * 不用 `hono/cookie`：WebSocket 升级拿到的是 `IncomingMessage`，没有 Hono
 * 上下文，两处必须走同一个解析器。
 *
 * @param header - 原始 `Cookie` 头。
 * @param name - cookie 名。
 * @returns 解码后的值，没有时为 undefined。
 */
export function readCookie(
  header: string | undefined,
  name: string
): string | undefined {
  if (header === undefined || header === "") {
    return undefined;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) {
      continue;
    }

    if (part.slice(0, separator).trim() !== name) {
      continue;
    }

    const value = part.slice(separator + 1).trim();

    if (value === "") {
      return undefined;
    }

    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** 从 `Cookie` 头里取出登录态令牌。 */
export function readSessionToken(
  header: string | undefined
): string | undefined {
  return readCookie(header, SESSION_COOKIE_NAME);
}

/**
 * 判断一个 `Origin` 是否可信。
 *
 * 没有 `Origin` 说明不是浏览器发起的（curl、测试），交给凭据本身判断。
 * 有 `Origin` 就必须在名单里；`Sec-Fetch-Site` 只能作为补充，不能单独
 * 用作依据。
 *
 * @param origin - 请求的 `Origin` 头。
 * @param allowed - 允许的源。
 */
export function isTrustedOrigin(
  origin: string | undefined,
  allowed: ReadonlySet<string>
): boolean {
  if (origin === undefined || origin === "") {
    return true;
  }

  return allowed.has(origin);
}

/**
 * 判断一个带登录态的请求是否可信。
 *
 * @param headers - 只用到 `get`，Hono 的 `c.req.header` 和 fetch `Headers` 都满足。
 * @param allowed - 允许的源，应已并入请求自身的源。
 */
export function isTrustedSessionRequest(
  headers: { get(name: string): string | null },
  allowed: ReadonlySet<string>
): boolean {
  if (headers.get("sec-fetch-site") === "cross-site") {
    return false;
  }

  return isTrustedOrigin(headers.get("origin") ?? undefined, allowed);
}

/**
 * 把请求自身的源并入名单。
 *
 * 只影响这一次判断；不要把它存起来，否则一个请求的 Host 会污染后续请求。
 *
 * @param allowed - 配置得到的源名单。
 * @param requestUrl - 请求的绝对地址。
 */
export function withRequestOrigin(
  allowed: ReadonlySet<string>,
  requestUrl: string
): ReadonlySet<string> {
  const { origin } = new URL(requestUrl);

  if (allowed.has(origin)) {
    return allowed;
  }

  return new Set([...allowed, origin]);
}

/**
 * 拼一条登录链接。
 *
 * 链接落在 web 源上：页面自己拿 `token` 换 cookie，再把这一个参数从地址栏
 * 抹掉。这样打开的就是应用本身，不是先到 API 再跳一次。
 *
 * @param webOrigin - web 文档的源。
 * @param ticket - 登录票据。
 */
export function buildSignInUrl({
  webOrigin,
  ticket,
}: {
  readonly webOrigin: string;
  readonly ticket: string;
}): string {
  const url = new URL("/", webOrigin);
  url.searchParams.set(SIGN_IN_TOKEN_PARAM, ticket);

  return url.href;
}

/** `setCookie` 需要的登录态属性；登录和续期必须完全一致。 */
export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly maxAge: number;
  readonly path: "/";
  readonly sameSite: "Lax";
  readonly secure: boolean;
}

/**
 * 登录态 cookie 的属性。
 *
 * 有公网源时按它的协议决定 `Secure`；否则看这次请求本身。局域网 http 必须
 * 为 false，否则浏览器直接丢弃 cookie，表现是“登录成功但下一页又是未登录”。
 *
 * @param env - 环境变量。
 * @param requestUrl - 请求的绝对地址。
 */
export function sessionCookieOptions(
  env: AuthEnv,
  requestUrl: string
): SessionCookieOptions {
  const publicOrigin = resolvePublicOrigin(env);
  const secure =
    publicOrigin === undefined
      ? new URL(requestUrl).protocol === "https:"
      : publicOrigin.startsWith("https://");

  return {
    httpOnly: true,
    // 寿命跟着登录态走；续期时用同一组属性重发一次。
    maxAge: Math.floor(AUTH_SESSION_TTL_MS / 1000),
    path: "/",
    sameSite: "Lax",
    secure,
  };
}
