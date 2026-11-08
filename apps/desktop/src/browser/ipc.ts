/**
 * 浏览器视图的 IPC 入口。
 *
 * 只有本窗口的主框架、并且文档源可信时，命令才生效。矩形和显隐用单向消息
 * （高频、无需回复）；创建和导航用请求-回复，地址被拒绝时能把原因带回界面。
 */
import type { BrowserViewInit } from "@workspace/shared/browser-protocol";
import { IPC_CHANNELS } from "@workspace/shared/constants";
import { logger as Logger } from "@workspace/shared/logger";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";

import { BrowserManager, isBounds } from "./manager";

const logger = Logger.createLogger({ scope: "browser-ipc" });

export type InstallBrowserIpcOptions = {
  readonly apiOrigin: () => string | undefined;
  readonly trustedDocument: (url: string | undefined) => boolean;
  readonly window: BrowserWindow;
};

/** 视图 id 的长度上限；它同时用作进程内的键。 */
const MAX_ID_LENGTH = 200;

function isId(value: unknown): value is string {
  return (
    typeof value === "string" && value !== "" && value.length <= MAX_ID_LENGTH
  );
}

function isViewInit(value: unknown): value is BrowserViewInit {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    isId(record.id) &&
    typeof record.sessionId === "string" &&
    record.sessionId !== "" &&
    (record.projectId === null || typeof record.projectId === "string") &&
    isBounds(record.bounds)
  );
}

/**
 * 注册浏览器视图的全部 IPC 通道。
 *
 * @param options - 窗口、文档源校验和 API origin。
 * @returns 管理这个窗口视图的管理器。
 */
export function installBrowserIpc({
  apiOrigin,
  trustedDocument,
  window,
}: InstallBrowserIpcOptions): BrowserManager {
  const manager = new BrowserManager({ apiOrigin, window });

  const isTrusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame;

    return (
      event.sender === window.webContents &&
      frame !== null &&
      frame === event.sender.mainFrame &&
      trustedDocument(frame.url)
    );
  };

  const reject = (channel: string): void => {
    logger.warn(`Rejected ${channel} from an untrusted renderer`);
  };

  ipcMain.handle(IPC_CHANNELS.BROWSER_CREATE, (event, value: unknown) => {
    if (!isTrusted(event) || !isViewInit(value)) {
      reject(IPC_CHANNELS.BROWSER_CREATE);

      return;
    }

    manager.create(value);
  });

  ipcMain.on(IPC_CHANNELS.BROWSER_DESTROY, (event, id: unknown) => {
    if (!isTrusted(event) || !isId(id)) {
      reject(IPC_CHANNELS.BROWSER_DESTROY);

      return;
    }

    manager.destroy(id);
  });

  ipcMain.on(
    IPC_CHANNELS.BROWSER_SET_BOUNDS,
    (event, id: unknown, bounds: unknown) => {
      if (!isTrusted(event) || !isId(id) || !isBounds(bounds)) {
        reject(IPC_CHANNELS.BROWSER_SET_BOUNDS);

        return;
      }

      manager.setBounds(id, bounds);
    }
  );

  ipcMain.on(
    IPC_CHANNELS.BROWSER_SET_VISIBLE,
    (event, id: unknown, visible: unknown) => {
      if (!isTrusted(event) || !isId(id) || typeof visible !== "boolean") {
        reject(IPC_CHANNELS.BROWSER_SET_VISIBLE);

        return;
      }

      manager.setVisible(id, visible);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.BROWSER_NAVIGATE,
    async (event, id: unknown, url: unknown) => {
      if (!isTrusted(event) || !isId(id) || typeof url !== "string") {
        reject(IPC_CHANNELS.BROWSER_NAVIGATE);

        throw new Error("The browser request was rejected.");
      }

      await manager.navigate(id, url);
    }
  );

  ipcMain.on(IPC_CHANNELS.BROWSER_BACK, (event, id: unknown) => {
    if (!isTrusted(event) || !isId(id)) {
      reject(IPC_CHANNELS.BROWSER_BACK);

      return;
    }

    manager.back(id);
  });

  ipcMain.on(IPC_CHANNELS.BROWSER_FORWARD, (event, id: unknown) => {
    if (!isTrusted(event) || !isId(id)) {
      reject(IPC_CHANNELS.BROWSER_FORWARD);

      return;
    }

    manager.forward(id);
  });

  ipcMain.on(IPC_CHANNELS.BROWSER_RELOAD, (event, id: unknown) => {
    if (!isTrusted(event) || !isId(id)) {
      reject(IPC_CHANNELS.BROWSER_RELOAD);

      return;
    }

    manager.reload(id);
  });

  return manager;
}
