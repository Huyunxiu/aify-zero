import { existsSync } from "node:fs";
import path from "node:path";
import util from "node:util";

import { resolveApiEndpoint } from "@workspace/shared/api-endpoint";
import type { ApiServerStatus } from "@workspace/shared/api-status";
import { resolveApiToken } from "@workspace/shared/api-token";
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
import { isLoopbackOrigin, normalizeServerOrigin } from "./server-origin";

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
 * 调用点在下面的单实例分支里：第二个实例不应该再注册协议或启动 server。
 */
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
 * 渲染端看到的最新 server 状态。新窗口加载完成时补发一次，避免错过启动
 * 阶段的推送。
 */
let currentServerStatus: ApiServerStatus = { state: "starting" };

const publishServerStatus = (status: ApiServerStatus): void => {
  currentServerStatus = status;

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.SERVER_STATUS, status);
    }
  }
};

/**
 * API server 的生命周期。默认自启内置 server；`AIFY_API_ORIGIN` 或
 * `AIFY_SERVER_MODE` 可以让它改成一个已经在跑的独立 server。
 */
const server = new DesktopServer({
  log: (message) => {
    logger.info(message);
  },
  // 开发期给 `dev:server` 一点启动时间；打包后只探一次，不拖慢冷启动。
  probeAttempts: isDev ? 5 : 1,
  probeDelayMs: 250,
  onStatus: publishServerStatus,
  // 延迟到真正需要时解析：模块加载阶段不碰用户目录，失败会走 whenReady
  // 里的统一错误弹窗。
  token: resolveApiToken,
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

  // 页面加载完成时补发当前状态：启动阶段的推送可能早于窗口存在。
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.send(
      IPC_CHANNELS.SERVER_STATUS,
      currentServerStatus
    );
  });

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

    // 运行期切换只接受回环地址：远程 server 必须在启动前通过
    // `AIFY_API_ORIGIN` + `AIFY_API_TOKEN` 配置，否则一个被注入的渲染端脚本
    // 就能把本机令牌发到任意主机。
    const normalized = normalizeServerOrigin(origin);
    if (!isLoopbackOrigin(normalized)) {
      throw new Error(
        "Only loopback API servers can be selected at runtime; set AIFY_API_ORIGIN and AIFY_API_TOKEN instead"
      );
    }

    const next = await server.attach(normalized);

    // 用发起请求的窗口重载；`onElectronReady` 里捕获的 mainWindow 在
    // macOS 关闭再 activate 之后可能已经销毁。
    BrowserWindow.fromWebContents(event.sender)?.reload();

    return next;
  });
};

const onElectronReady = async () => {
  // 启动过程中用户已经退出（例如 Cmd+Q）：不要再起 server，否则 before-quit
  // 的 stop() 已经跑完，这个晚到的子进程会变成孤儿。
  if (isQuitting) {
    return;
  }

  setupBundledRipgrep();
  setupMacDockIcon();

  // 默认模式下渲染端经主进程转发，内置 server 不需要固定端口：用 0 让系统
  // 分配，避免和 `dev:server`、另一个实例或占端口的进程冲突。显式设置了
  // `AIFY_API_PORT`，或者关掉协议走 Vite 代理时，才需要固定端口。
  const configuredOrigin = process.env.AIFY_API_ORIGIN?.trim();
  const mode = process.env.AIFY_SERVER_MODE ?? "auto";
  const mayStartOwned =
    mode === "owned" ||
    (mode === "auto" &&
      (configuredOrigin === undefined || configuredOrigin === ""));

  let ownedPort: number | undefined;

  if (mayStartOwned) {
    const endpoint = resolveApiEndpoint();

    if (!useProtocol && endpoint.port === 0) {
      throw new Error(
        "AIFY_APP_PROTOCOL=0 needs a fixed AIFY_API_PORT (or AIFY_API_ORIGIN) so the Vite proxy can reach the API"
      );
    }

    ownedPort = endpoint.portExplicit || !useProtocol ? endpoint.port : 0;
  }

  // `start()` 已经解析过令牌（并写进子进程环境），这里拿到的就是同一个值。
  const apiToken = resolveApiToken();

  // 窗口先出来，server 在后台继续启动。协议 handler 在 origin 还是
  // undefined 时会等这个 promise，而不是让首屏请求直接吃 503。
  const waitForOrigin = async (): Promise<string | undefined> => {
    try {
      await start;
    } catch {
      // 启动失败由 onElectronReady 的调用方弹窗；这里只负责把请求落成 503。
    }

    return server.origin;
  };

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
        api: {
          origin: () => server.origin,
          token: apiToken,
          waitForOrigin,
        },
        devServerUrl,
        webRoot: isDev ? undefined : rendererRoot(),
      })
    );
  }

  const start = server.start({
    cwd: app.isPackaged
      ? app.getPath("userData")
      : path.resolve(app.getAppPath(), "../.."),
    // oxlint-disable-next-line unicorn/prefer-module
    entry: path.join(__dirname, "server-entry.js"),
    env: serverEnvironment(),
    port: ownedPort,
  });
  // 启动失败由下面的 await 处理；这里先挂一个 handler，避免窗口先显示时
  // 这段等待期产生 unhandled rejection。
  void start.catch((error: unknown) => {
    logger.debug("API server did not start before the window opened", error);
  });

  await installExtensions();

  // 先建窗口再注册 IPC：ipc handler 的模块求值依赖 ipcContext.mainWindow。
  const mainWindow = buildWindow();
  await setupIpcServer();
  installServerSelectionIpc();
  showWindow(mainWindow);

  const origin = await start;
  logger.info(`API server: ${origin}`);
};

/** 第二个实例启动时，把已有窗口拉到前台，而不是再起一套 server。 */
const focusExistingWindow = (): void => {
  const [existing] = BrowserWindow.getAllWindows();

  if (existing === undefined) {
    return;
  }

  if (existing.isMinimized()) {
    existing.restore();
  }

  existing.show();
  existing.focus();
};

let isQuitting = false;

/**
 * 单实例锁：两个 App 实例同时运行会争抢默认端口和同一个 SQLite 库，而且
 * 先退出的一方会把它“拥有”的 server 一起带走，另一个实例随后就只剩 503。
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // 必须在 app ready 之前注册，否则 Chromium 不会把 aify-app:// 当作标准源。
  registerAppScheme();

  app.on("second-instance", focusExistingWindow);

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  void app.whenReady().then(async () => {
    try {
      await onElectronReady();
    } catch (error) {
      // 没有窗口时 console 没人看得见：迁移失败之类的启动错误必须弹出来，
      // 否则用户只会看到图标一闪。退出过程中的中断不算启动失败。
      logger.error("Error during app initialization", error);
      if (!isQuitting) {
        publishServerStatus({
          message: error instanceof Error ? error.message : String(error),
          state: "unavailable",
        });
        dialog.showErrorBox(
          "Aify Zero failed to start",
          error instanceof Error ? error.message : String(error)
        );
      }
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
  // 退出必须等子进程收尾：否则端口、SQLite 句柄和迁移都可能被半途砍掉。
  app.on("before-quit", (event) => {
    if (isQuitting) {
      return;
    }

    isQuitting = true;
    event.preventDefault();

    void server
      .stop()
      .catch((error: unknown) => {
        logger.error("Failed to stop the API server", error);
      })
      .finally(() => {
        app.quit();
      });
  });

  app.on("activate", () => {
    // On OS X it's common to re-create a window when the dock icon is clicked
    // and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}
