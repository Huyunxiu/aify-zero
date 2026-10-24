import { existsSync } from "node:fs";
import path from "node:path";
import util from "node:util";

import { APP_SCHEME, APP_URL, isAppUrl } from "@workspace/shared/app-url";
import { IPC_CHANNELS, inDevelopment } from "@workspace/shared/constants";
import { logger as Logger } from "@workspace/shared/logger";
import { app, BrowserWindow, dialog, protocol, shell } from "electron";
import {
  installExtension,
  REACT_DEVELOPER_TOOLS,
} from "electron-devtools-installer";
import log from "electron-log/main";
import started from "electron-squirrel-startup";
import { ipcMain } from "electron/main";

import { ipcContext } from "@/ipc/context";

import { createAppProtocolHandler, registerAppScheme } from "./protocol";
import { DesktopServer } from "./server-manager";

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
Logger.createLogger = ({ scope }) => ({
  ...Logger,
  ...log.scope(scope),
});
Object.assign(console, log.functions);

const logger = Logger.createLogger({ scope: "main.js" });

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

/**
 * 必须在 app ready 之前注册，否则 Chromium 不会把 aify-app:// 当作标准源。
 */
registerAppScheme();

const isDev = !app.isPackaged;

/**
 * 开发和生产默认都走 aify-app://：开发期协议 handler 反代 Vite，生产期
 * 读打包产物。`AIFY_APP_PROTOCOL=0` 是排障用的逃生口，直接加载 Vite URL。
 */
const useProtocol = !isDev || process.env.AIFY_APP_PROTOCOL !== "0";

/**
 * 打包后没有仓库里的 `.env` / `local.db`，数据库落在 `~/.aify-zero`，
 * 首次启动要用随包携带的迁移建表；开发期沿用 `db:push` 的本地库。
 */
const migrationsDirectory = app.isPackaged
  ? path.join(process.resourcesPath, "migrations")
  : path.resolve(app.getAppPath(), "../../packages/db/src/migrations");

/**
 * API server 的生命周期。默认自启内置 server；`AIFY_API_ORIGIN` 或
 * `AIFY_SERVER_MODE` 可以让它改成一个已经在跑的独立 server。
 */
const server = new DesktopServer((message) => {
  logger.info(message);
});

/**
 * 内置 server 子进程的环境。
 *
 * 开发期显式给 `DATABASE_URL`，否则子进程会落到 `~/.aify-zero`，和
 * `dev:server` / `db:push` 使用的仓库 `local.db` 不是同一个库。迁移目录
 * 只在打包后提供：开发库由 `db:push` 维护，重放迁移会和已有表冲突。
 */
const serverEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (app.isPackaged) {
    env.AIFY_MIGRATIONS_DIR = migrationsDirectory;
  } else if (env.DATABASE_URL === undefined || env.DATABASE_URL === "") {
    // 开发期的内置 server 必须和 `dev:server` / `db:push` 用同一个库。
    env.DATABASE_URL = `file:${path.resolve(app.getAppPath(), "../../local.db")}`;
  }

  return env;
};

/** 开发期的前端 dev server 地址；生产为 undefined。 */
const rendererDevUrl = (): string | undefined => {
  const explicit = process.env.AIFY_WEB_DEV_URL;
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }

  // Forge 只在 serve 时注入真实 URL；用 typeof 读取，生产构建里即使
  // 这个标识不存在也不会抛 ReferenceError。Vite 绑在 127.0.0.1，而 Forge
  // 给出的地址是 localhost，这里统一成同一个 origin，避免 IPv6 解析歧义。
  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "string") {
    return undefined;
  }

  try {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
    }
    return url.origin;
  } catch {
    return undefined;
  }
};
/** Forge renderer 构建产物目录（开发期在 .vite，打包后在 asar 内）。 */
const rendererRoot = (): string =>
  // oxlint-disable-next-line unicorn/prefer-module
  path.join(__dirname, "../renderer", MAIN_WINDOW_VITE_NAME);

/**
 * 只信任应用文档源；开发期另外信任实际加载的 Vite origin。
 */
const isTrustedDocument = (url: string | undefined): boolean => {
  if (url === undefined) {
    return false;
  }
  if (isAppUrl(url)) {
    return true;
  }

  const dev = rendererDevUrl();
  if (!isDev || dev === undefined) {
    return false;
  }

  try {
    return new URL(url).origin === new URL(dev).origin;
  } catch {
    return false;
  }
};

const installExtensions = async () => {
  try {
    const result = await installExtension(REACT_DEVELOPER_TOOLS);
    console.log(`Extensions installed successfully: ${result.name}`);
  } catch {
    console.error("Failed to install extensions");
  }
};

const buildWindow = (): BrowserWindow => {
  // oxlint-disable-next-line unicorn/prefer-module
  const dirname = __dirname;
  const mainWindow = new BrowserWindow({
    height: 900,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 16 },
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      contextIsolation: true,
      devTools: inDevelopment,
      nodeIntegration: false,
      preload: path.join(dirname, "preload.js"),
    },
    width: 1400,
  });

  // ipcContext 的 getter 在 ipc/handler 的模块求值时就会读 mainWindow，
  // 所以窗口必须先于 setupIpcServer() 创建。
  ipcContext.setMainWindow(mainWindow);

  // 应用之外的导航交给系统浏览器，窗口本身只停留在自己的文档源。
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isTrustedDocument(target)) {
      return { action: "allow" };
    }

    if (target.startsWith("http:") || target.startsWith("https:")) {
      void shell.openExternal(target);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (isTrustedDocument(target)) {
      return;
    }

    event.preventDefault();
    logger.warn(`Blocked navigation to ${target}`);
    if (target.startsWith("http:") || target.startsWith("https:")) {
      void shell.openExternal(target);
    }
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, code, description, target, isMainFrame) => {
      if (isMainFrame) {
        logger.warn(`Failed to load ${target}: ${String(code)} ${description}`);
      }
    }
  );

  return mainWindow;
};

const showWindow = (mainWindow: BrowserWindow): void => {
  const url = useProtocol ? APP_URL : rendererDevUrl();
  if (url === undefined) {
    throw new Error(
      "Renderer URL is unavailable: start the app through electron-forge start, or set AIFY_WEB_DEV_URL."
    );
  }
  void mainWindow.loadURL(url);

  // 开发期默认打开 DevTools；`AIFY_OPEN_DEVTOOLS=0` 关掉。打包后一律不开：
  // webPreferences.devTools 已经随 inDevelopment 关闭，这里只是别让代码
  // 在打包环境里仍表达“要打开”的意图。
  if (isDev && process.env.AIFY_OPEN_DEVTOOLS !== "0") {
    mainWindow.webContents.openDevTools();
  }
};

const createWindow = (): BrowserWindow => {
  const mainWindow = buildWindow();
  showWindow(mainWindow);
  return mainWindow;
};

const setupIpcServer = async () => {
  const { rpcHandler } = await import("./ipc/handler");

  ipcMain.on(IPC_CHANNELS.START_IPC_SERVER, (event) => {
    const frame = event.senderFrame;
    if (
      frame === null ||
      frame !== event.sender.mainFrame ||
      !isTrustedDocument(frame.url)
    ) {
      logger.warn("Rejected desktop IPC from an untrusted renderer");
      return;
    }

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

// Puts the ripgrep shipped in extraResource ahead of whatever the user has on
// PATH, so the agent's grep/glob tools behave the same on every machine.
const setupBundledRipgrep = () => {
  // oxlint-disable-next-line unicorn/prefer-module
  const dirname = __dirname;

  const rgDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "resources", "bin")
    : path.join(dirname, "../../resources/bin");

  if (!existsSync(rgDirectory)) {
    logger.warn(`Bundled ripgrep not found at ${rgDirectory}`);
    return;
  }

  process.env.PATH = `${rgDirectory}${path.delimiter}${process.env.PATH ?? ""}`;
};

/**
 * 运行时切换 API server。现在还没有设置界面，但先把入口留好：渲染端调用
 * `aifyDesktop.useServer(origin)` 就会停掉内置子进程、把转发目标换成外部
 * server，并重载文档。
 */
const installServerSelectionIpc = (): void => {
  ipcMain.handle(IPC_CHANNELS.USE_SERVER, async (event, origin: unknown) => {
    const frame = event.senderFrame;
    if (
      frame === null ||
      frame !== event.sender.mainFrame ||
      !isTrustedDocument(frame.url)
    ) {
      throw new Error("Rejected API server switch from an untrusted renderer");
    }
    if (typeof origin !== "string" || origin === "") {
      throw new Error("API server origin must be a non-empty string");
    }

    const next = await server.attach(origin);

    // 用发起请求的窗口重载；`onElectronReady` 里捕获的 mainWindow 在
    // macOS 关闭再 activate 之后可能已经销毁。
    BrowserWindow.fromWebContents(event.sender)?.reload();

    return next;
  });
};

const onElectronReady = async () => {
  setupBundledRipgrep();
  setupMacDockIcon();

  const origin = await server.start({
    cwd: app.isPackaged
      ? app.getPath("userData")
      : path.resolve(app.getAppPath(), "../.."),
    // oxlint-disable-next-line unicorn/prefer-module
    entry: path.join(__dirname, "server-entry.js"),
    env: serverEnvironment(),
  });
  logger.info(`API server: ${origin}`);

  if (useProtocol) {
    const devServerUrl = isDev ? rendererDevUrl() : undefined;
    if (isDev && devServerUrl === undefined) {
      throw new Error(
        "aify-app:// needs a dev server: start through electron-forge start or set AIFY_WEB_DEV_URL."
      );
    }

    protocol.handle(
      APP_SCHEME,
      createAppProtocolHandler({
        api: { origin: () => server.origin },
        devServerUrl,
        webRoot: isDev ? undefined : rendererRoot(),
      })
    );
  }

  await installExtensions();

  // 先建窗口再注册 IPC：ipc handler 的模块求值依赖 ipcContext.mainWindow。
  const mainWindow = buildWindow();
  await setupIpcServer();
  installServerSelectionIpc();
  showWindow(mainWindow);
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
void app.whenReady().then(async () => {
  try {
    await onElectronReady();
  } catch (error) {
    // 没有窗口时 console 没人看得见：迁移失败之类的启动错误必须弹出来，
    // 否则用户只会看到图标一闪。
    logger.error("Error during app initialization", error);
    dialog.showErrorBox(
      "Aify Zero failed to start",
      error instanceof Error ? error.message : String(error)
    );
    app.quit();
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

// 只有自启的内置 server 会被停掉；attach 到外部 server 时这里不碰它。
app.on("will-quit", () => {
  server.stop();
});

app.on("activate", () => {
  // On OS X it's common to re-create a window when the dock icon is clicked
  // and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
