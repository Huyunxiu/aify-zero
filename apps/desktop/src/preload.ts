import { IPC_CHANNELS } from "@workspace/shared/constants";
import { contextBridge, ipcRenderer } from "electron";

// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

// 渲染端用它判断自己是否运行在桌面壳里。只暴露非敏感的静态信息，
// 真正的原生能力仍然走下面的 message-port IPC。
contextBridge.exposeInMainWorld("aifyDesktop", {
  platform: process.platform,
});

window.addEventListener("message", (event) => {
  if (event.data === IPC_CHANNELS.START_IPC_CLIENT) {
    const [serverPort] = event.ports;

    ipcRenderer.postMessage(IPC_CHANNELS.START_IPC_SERVER, null, [serverPort]);
  }
});
