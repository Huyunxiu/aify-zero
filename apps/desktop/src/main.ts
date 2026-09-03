import type { AddressInfo } from "node:net";
import path from "node:path";
import util from "node:util";

import { serve } from "@hono/node-server";
import { app as server } from "@workspace/server/app";
import { IPC_CHANNELS, inDevelopment } from "@workspace/shared/constants";
import { logger as Logger } from "@workspace/shared/logger";
import { app, BrowserWindow } from "electron";
import {
  installExtension,
  REACT_DEVELOPER_TOOLS,
} from "electron-devtools-installer";
import log from "electron-log/main";
import started from "electron-squirrel-startup";
import { ipcMain } from "electron/main";

import { ipcContext } from "@/ipc/context";

log.initialize();
log.scope.labelPadding = false;
log.transports.console.format =
  "[{iso}] [{processType}] [{scope}] [{level}] {text}";
log.transports.file.format = ({ data, level, message }) => {
  const text = util.format(...data);

  return [
    JSON.stringify({
      timestamp: message.date.toISOString(),
      processType: message.variables?.processType,
      scope: message.scope,
      level,
      text,
    }),
  ];
};
// 10MB
log.transports.file.maxSize = 10 * 1024 * 1024;
Logger.createLogger = ({ scope }) => {
  return {
    ...Logger,
    ...log.scope(scope),
  };
};
Object.assign(console, log.functions);

const logger = Logger.createLogger({ scope: "main.js" });

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const createServer = async () =>
  await new Promise<AddressInfo>((resolve) => {
    serve(
      {
        fetch: server.fetch,
        port: 18_086,
      },
      (info) => {
        logger.log(`Server is running on http://localhost:${info.port}`);
        resolve(info);
      }
    );
  });

const installExtensions = async () => {
  try {
    const result = await installExtension(REACT_DEVELOPER_TOOLS);
    console.log(`Extensions installed successfully: ${result.name}`);
  } catch {
    console.error("Failed to install extensions");
  }
};

const createWindow = () => {
  // const dirname = path.dirname(fileURLToPath(import.meta.dirname));
  // oxlint-disable-next-line unicorn/prefer-module
  const dirname = __dirname;
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    height: 900,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 16 },
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      devTools: inDevelopment,
      preload: path.join(dirname, "preload.js"),
    },
    width: 1400,
  });

  ipcContext.setMainWindow(mainWindow);

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

const setupIpcServer = async () => {
  const { rpcHandler } = await import("./ipc/handler");

  ipcMain.on(IPC_CHANNELS.START_IPC_SERVER, (event) => {
    const [serverPort] = event.ports;

    rpcHandler.upgrade(serverPort);
    serverPort.start();
  });
};

// macOS-only startup step: set dock icon and optional multi-instance badge.
const setupMacDockIcon = () => {
  // oxlint-disable-next-line unicorn/prefer-module
  const dirname = __dirname;

  if (process.platform !== "darwin" || !app.dock) {
    return;
  }

  const dockIconPath = app.isPackaged
    ? path.join(dirname, "../../../resources/icons/icon.png")
    : path.join(dirname, "../../resources/icons/icon.png");

  app.dock.setIcon(dockIconPath);
};

const onElectronReady = async () => {
  setupMacDockIcon();
  createWindow();
  await installExtensions();
  await setupIpcServer();
  await createServer();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
void app.whenReady().then(async () => {
  try {
    await onElectronReady();
  } catch (error) {
    console.error("Error during app initialization:", error);
  }
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
