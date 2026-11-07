/**
 * 终端通道的地址。
 *
 * 浏览器：地址从当前文档源推出，token 由 Vite 代理在升级请求上注入。
 * 桌面：文档源是 `aify-app://`，没有 WebSocket scheme，地址由主进程给出。
 * 两条路径都在地址上追加 `sessionId` 和初始尺寸；尺寸会作为 PTY 的初始大小。
 */
import { resolveWebSocketUrl } from "./channel";

export interface TerminalSocketOptions {
  readonly cols: number;
  readonly rows: number;
  readonly sessionId: string;
}

/**
 * 解析一条终端连接的完整地址。
 *
 * @param options - 会话 id 和当前终端的行列数。
 * @returns 可以交给 `WebSocketTransport` 的 `ws://` 或 `wss://` 地址。
 */
export async function resolveTerminalUrl({
  cols,
  rows,
  sessionId,
}: TerminalSocketOptions): Promise<string> {
  const bridge = typeof window === "undefined" ? undefined : window.aifyDesktop;
  const base =
    bridge?.terminalUrl === undefined
      ? resolveWebSocketUrl("api/terminal")
      : await bridge.terminalUrl();
  const url = new URL(base);

  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("cols", String(cols));
  url.searchParams.set("rows", String(rows));

  return url.href;
}
