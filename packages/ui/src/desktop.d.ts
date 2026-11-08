import type { ApiServerStatus } from "@workspace/shared/api-status";
import type { BrowserBridge } from "@workspace/shared/browser-protocol";

declare global {
  interface Window {
    /** 桌面壳 preload 注入；浏览器里不存在。 */
    aifyDesktop?: {
      readonly platform: string;
      useServer(origin: string): Promise<string>;
      getServerStatus(): ApiServerStatus | undefined;
      onServerStatus(listener: (status: ApiServerStatus) => void): number;
      offServerStatus(id: number): void;
      /** 应用通道的 WebSocket 地址；aify-app:// 没有 ws scheme。 */
      channelUrl?(): Promise<string>;
      /** 终端通道的 WebSocket 地址。 */
      terminalUrl?(): Promise<string>;
      /** 原生浏览器视图；浏览器里没有它，入口据此隐藏。 */
      browser?: BrowserBridge;
    };
  }
}
