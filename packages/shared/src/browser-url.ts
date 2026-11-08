/**
 * 浏览器视图能打开的地址。
 *
 * 规则只有一条主线：http(s)、不带凭据、不能碰到应用自己的服务。其余输入
 * 先当作「用户少写了协议」补成 https，再交给标准 URL 解析。这里是纯函数，
 * 主进程和渲染端共用；真正的拦截仍然在主进程执行。
 */

/** 拒绝的原因；调用方据此给用户一句话。 */
export const BROWSER_URL_REJECTIONS = [
  "empty",
  "invalid",
  "scheme",
  "credentials",
  "app-origin",
  "loopback-port",
] as const;

export type BrowserUrlRejection = (typeof BROWSER_URL_REJECTIONS)[number];

/**
 * 判断一个字符串是不是已知的拒绝原因。
 *
 * @param value - 待检查的字符串。
 * @returns 是已知原因时为 true。
 */
export function isBrowserUrlRejection(
  value: string
): value is BrowserUrlRejection {
  return (BROWSER_URL_REJECTIONS as readonly string[]).includes(value);
}

export type BrowserUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: BrowserUrlRejection };

/** 看起来已经带协议头的输入，例如 `https:`、`file:`、`aify-app:`。 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** 带 `//` 的协议头；这类输入一定是完整 URL。 */
const HAS_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
/** 主机名加端口，例如 `localhost:3000`、`example.com:8080/a`。 */
const HOST_WITH_PORT = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i;

/**
 * 用户往往省略协议；只有看起来真是自定义协议时才原样交给 URL 解析，
 * 否则补上 https，避免把 `localhost:3000` 当成一个叫 localhost 的协议。
 *
 * @param text - 去掉首尾空白后的地址栏原文。
 * @returns 可以交给 `new URL` 的文本。
 */
function withScheme(text: string): string {
  if (HAS_AUTHORITY.test(text)) {
    return text;
  }

  if (HAS_SCHEME.test(text) && !HOST_WITH_PORT.test(text)) {
    return text;
  }

  return `https://${text}`;
}

/**
 * 回环主机名。Chromium 把 `[::1]` 保留成这种带方括号的写法。
 *
 * @param hostname - `URL.hostname`。
 * @returns 是回环地址时为 true。
 */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * 解析用户在地址栏里写的东西。
 *
 * @param input - 地址栏原文。
 * @param options.apiOrigin - 当前 API server 的 origin；未知时只做协议检查。
 * @returns 放行的规范地址，或拒绝原因。
 */
export function resolveBrowserUrl(
  input: string,
  options: { readonly apiOrigin?: string | null } = {}
): BrowserUrlResult {
  const text = input.trim();

  if (text === "") {
    return { ok: false, reason: "empty" };
  }

  let parsed: URL;

  try {
    parsed = new URL(withScheme(text));
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "scheme" };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "credentials" };
  }

  const apiOrigin = options.apiOrigin ?? null;

  if (apiOrigin !== null) {
    const api = new URL(apiOrigin);

    if (parsed.origin === api.origin) {
      return { ok: false, reason: "app-origin" };
    }

    // 服务监听在回环上：换一个回环主机名也是同一台机器、同一个端口。
    if (isLoopbackHost(parsed.hostname) && parsed.port === api.port) {
      return { ok: false, reason: "loopback-port" };
    }
  }

  return { ok: true, url: parsed.href };
}
