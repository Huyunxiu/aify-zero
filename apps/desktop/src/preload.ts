import { IPC_CHANNELS } from "@workspace/shared/constants";
import { ipcRenderer } from "electron";
// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

window.addEventListener("message", (event) => {
  if (event.data === IPC_CHANNELS.START_IPC_CLIENT) {
    const [serverPort] = event.ports;

    ipcRenderer.postMessage(IPC_CHANNELS.START_IPC_SERVER, null, [serverPort]);
  }
});
