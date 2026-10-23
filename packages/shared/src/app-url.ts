/**
 * 应用文档的自定义协议。
 *
 * 桌面窗口加载 `aify-app://app/`，由 Electron 的 protocol handler 提供静态
 * 资源和 API 转发；普通浏览器仍然走 http(s)。渲染端只使用文档相对路径，
 * 因此同一份前端产物在两种文档所有者下都能工作。
 */
export const APP_SCHEME = "aify-app";

/** 应用文档的 host。协议 handler 只接受这一个 host。 */
export const APP_HOST = "app";

/** 桌面窗口的文档源，例如 `aify-app://app`。 */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** 桌面窗口的入口 URL，末尾的斜杠让相对 URL 落在根目录。 */
export const APP_URL = `${APP_ORIGIN}/`;

/**
 * 判断一个 URL 是否属于应用文档源。
 *
 * 不能比较 `URL.origin`：在 Node 里自定义 scheme 的 origin 是字符串
 * `"null"`，只有 Chromium 把它注册成 standard scheme 后才有 tuple origin。
 * 主进程的导航/IPC 校验都跑在 Node 里，所以这里按 scheme + host 判断，
 * 顺带拒绝端口、用户名和密码——`aify-app://app:1234/` 在 Chromium 里是
 * 另一个 origin，不该被当成应用自己。
 *
 * @param url - 待检查的绝对 URL；不是合法 URL 时返回 false。
 */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === `${APP_SCHEME}:` &&
      parsed.hostname === APP_HOST &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}
