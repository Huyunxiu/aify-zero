import { ipc } from "@/ipc/manager";

export async function getPlatform() {
  return await ipc.client.app.currentPlatfom();
}

export async function getAppVersion() {
  return await ipc.client.app.appVersion();
}
