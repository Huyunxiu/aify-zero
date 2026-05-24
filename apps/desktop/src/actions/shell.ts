import { ipc } from "@/ipc/manager";

export async function openExternalLink(url: string) {
  await ipc.client.shell.openExternalLink({ url });
}
