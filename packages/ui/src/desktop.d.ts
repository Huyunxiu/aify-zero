import type { ApiServerStatus } from "@workspace/shared/api-status";

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
      /** 用户点了发件箱的通知：要切到的会话。 */
      onOpenSession?(listener: (sessionId: string) => void): number;
      offOpenSession?(id: number): void;
      /** 界面语言；托盘这类原生界面按它换文案。 */
      setLanguage?(language: string): void;
    };
  }
}
