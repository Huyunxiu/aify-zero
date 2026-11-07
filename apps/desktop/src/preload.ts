import type { ApiServerStatus } from "@workspace/shared/api-status";
import { IPC_CHANNELS } from "@workspace/shared/constants";
import { contextBridge, ipcRenderer } from "electron";

// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

let lastServerStatus: ApiServerStatus | undefined;
let nextServerStatusListenerId = 0;
const serverStatusListeners = new Map<
  number,
  (status: ApiServerStatus) => void
>();

ipcRenderer.on(
  IPC_CHANNELS.SERVER_STATUS,
  (_event, status: ApiServerStatus) => {
    lastServerStatus = status;

    for (const listener of serverStatusListeners.values()) {
      listener(status);
    }
  }
);

// 渲染端用它判断自己是否运行在桌面壳里。只暴露非敏感的静态信息，
// 真正的原生能力仍然走下面的 message-port IPC。
contextBridge.exposeInMainWorld("aifyDesktop", {
  platform: process.platform,
  // 蓝色按钮之外的第一块“服务器”能力：把内置 server 换成外部 origin。
  // 主进程会先做 /health 检查，再停掉内置子进程并重载文档。
  useServer: (origin: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.USE_SERVER, origin) as Promise<string>,
  // 当前 server 状态 + 订阅。返回 id，渲染端用 offServerStatus 取消订阅。
  getServerStatus: (): ApiServerStatus | undefined => lastServerStatus,
  onServerStatus: (listener: (status: ApiServerStatus) => void): number => {
    nextServerStatusListenerId += 1;
    serverStatusListeners.set(nextServerStatusListenerId, listener);

    return nextServerStatusListenerId;
  },
  offServerStatus: (id: number): void => {
    serverStatusListeners.delete(id);
  },
  // 应用通道的地址。桌面文档源是 aify-app://，WebSocket 没有对应的 scheme，
  // 所以地址由主进程拼好。地址里不带令牌：升级请求的凭据由主进程在发出前
  // 注入，渲染端拿不到它。
  channelUrl: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_URL) as Promise<string>,
  // 终端通道和通道走同一套鉴权与注入逻辑，只是路径不同。
  terminalUrl: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_URL) as Promise<string>,
});

window.addEventListener("message", (event) => {
  if (event.data === IPC_CHANNELS.START_IPC_CLIENT) {
    const [serverPort] = event.ports;

    ipcRenderer.postMessage(IPC_CHANNELS.START_IPC_SERVER, null, [serverPort]);
  }
});
