/**
 * 浏览器视图的主进程部分。
 *
 * 每个标签对应一个 `WebContentsView`，由窗口的 `contentView` 托管。渲染端只
 * 上报矩形和显隐，主进程不再推算布局；导航状态从页面事件汇总后推回地址栏。
 * 视图的网页内容按不可信处理：沙箱、无 Node、无 preload、不能开 webview。
 */
import type {
  BrowserBounds,
  BrowserNavigationState,
  BrowserViewInit,
} from "@workspace/shared/browser-protocol";
import { BROWSER_URL_REJECTION_PREFIX } from "@workspace/shared/browser-protocol";
import { resolveBrowserUrl } from "@workspace/shared/browser-url";
import { IPC_CHANNELS } from "@workspace/shared/constants";
import { logger as Logger } from "@workspace/shared/logger";
import type { BrowserWindow, Event as ElectronEvent } from "electron";
import { session, WebContentsView } from "electron";

const logger = Logger.createLogger({ scope: "browser" });

/** 已经配过权限策略的档案分区。 */
const configuredPartitions = new Set<string>();

type ManagedView = {
  readonly view: WebContentsView;
  readonly id: string;
  visible: boolean;
};

export type BrowserManagerOptions = {
  /** API server 当前的 origin；未就绪时为 undefined。 */
  readonly apiOrigin: () => string | undefined;
  readonly window: BrowserWindow;
};

/**
 * 一个项目（没有项目时是一个会话）共用的浏览器档案。
 *
 * @param init - 视图创建参数。
 * @returns Electron 的持久分区名。
 */
function profilePartition(init: BrowserViewInit): string {
  const scope =
    init.projectId === null
      ? `session-${init.sessionId}`
      : `project-${init.projectId}`;

  return `persist:browser-${encodeURIComponent(scope)}`;
}

/** 数值有限且非负的矩形；渲染端送来的值不可信。 */
function isBounds(value: unknown): value is BrowserBounds {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.x === "number" &&
    Number.isFinite(record.x) &&
    typeof record.y === "number" &&
    Number.isFinite(record.y) &&
    typeof record.width === "number" &&
    Number.isFinite(record.width) &&
    record.width >= 0 &&
    typeof record.height === "number" &&
    Number.isFinite(record.height) &&
    record.height >= 0
  );
}

export class BrowserManager {
  private readonly apiOrigin: () => string | undefined;
  private readonly views = new Map<string, ManagedView>();
  private readonly window: BrowserWindow;

  constructor(options: BrowserManagerOptions) {
    this.apiOrigin = options.apiOrigin;
    this.window = options.window;

    this.window.on("closed", () => {
      this.destroyAll();
    });
  }

  /**
   * 建立一个视图。标签 id 就是视图 id。
   *
   * @param init - 视图 id、档案范围和初始矩形。
   */
  create(init: BrowserViewInit): void {
    if (this.views.has(init.id) || this.window.isDestroyed()) {
      return;
    }

    const partition = profilePartition(init);
    const scope = session.fromPartition(partition);

    if (!configuredPartitions.has(partition)) {
      // 页面内容是外部输入；权限一律拒绝，需要时再逐项放开。
      scope.setPermissionCheckHandler(() => false);
      scope.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(false);
      });
      configuredPartitions.add(partition);
    }

    const view = new WebContentsView({
      webPreferences: {
        // 面板动画和浮层期间视图会被隐藏，后台节流会让恢复时闪烁。
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        session: scope,
        // 网页里不能再嵌 webview。
        webviewTag: false,
      },
    });

    view.setBackgroundColor("#ffffff");
    view.setBounds(init.bounds);
    this.window.contentView.addChildView(view);
    view.setVisible(false);

    const managed: ManagedView = {
      id: init.id,
      view,
      visible: false,
    };

    this.views.set(init.id, managed);
    this.attach(managed);
    this.publish(managed);
    logger.info(`Created browser view ${init.id} in partition ${partition}`);
  }

  /**
   * 关闭一个视图；标签关闭时调用。
   *
   * @param id - 视图 id。
   */
  destroy(id: string): void {
    const managed = this.views.get(id);

    if (managed === undefined) {
      return;
    }

    this.views.delete(id);

    if (!this.window.isDestroyed()) {
      this.window.contentView.removeChildView(managed.view);
    }

    managed.view.webContents.close();
  }

  /** 窗口关闭或应用退出时清空所有视图。 */
  destroyAll(): void {
    // Map 的迭代器允许在迭代中删除当前键。
    for (const id of this.views.keys()) {
      this.destroy(id);
    }
  }

  setBounds(id: string, bounds: BrowserBounds): void {
    this.views.get(id)?.view.setBounds(bounds);
  }

  setVisible(id: string, visible: boolean): void {
    const managed = this.views.get(id);

    if (managed === undefined || managed.visible === visible) {
      return;
    }

    managed.visible = visible;
    managed.view.setVisible(visible);
    logger.info(`Browser view ${id} ${visible ? "shown" : "hidden"}`);
  }

  /**
   * 打开一个地址。策略在真正导航前执行，重定向也会再检查一次。
   *
   * @param id - 视图 id。
   * @param input - 地址栏原文。
   * @throws {Error} 地址不被允许，或页面加载失败。
   */
  async navigate(id: string, input: string): Promise<void> {
    const managed = this.views.get(id);

    if (managed === undefined) {
      throw new Error("The browser view is no longer open.");
    }

    const result = resolveBrowserUrl(input, {
      apiOrigin: this.apiOrigin(),
    });

    if (!result.ok) {
      throw new Error(`${BROWSER_URL_REJECTION_PREFIX}${result.reason}`);
    }

    logger.info(`Browser view ${id} navigating to ${result.url}`);
    await managed.view.webContents.loadURL(result.url);
  }

  back(id: string): void {
    const history = this.views.get(id)?.view.webContents.navigationHistory;

    if (history?.canGoBack() === true) {
      history.goBack();
    }
  }

  forward(id: string): void {
    const history = this.views.get(id)?.view.webContents.navigationHistory;

    if (history?.canGoForward() === true) {
      history.goForward();
    }
  }

  reload(id: string): void {
    this.views.get(id)?.view.webContents.reload();
  }

  /**
   * 挂上页面事件：导航、标题、加载状态都要变成地址栏能读的状态。
   *
   * @param managed - 新建立的视图。
   */
  private attach(managed: ManagedView): void {
    const contents = managed.view.webContents;
    const send = (): void => {
      this.publish(managed);
    };

    contents.on("did-start-loading", send);
    contents.on("did-stop-loading", send);
    contents.on("did-navigate", send);
    contents.on("did-navigate-in-page", send);
    contents.on("page-title-updated", send);
    contents.on("did-fail-load", send);

    // 页面里的链接和脚本发起的导航同样受限：只允许策略认可的 http(s)。
    const guard = (event: ElectronEvent, target: string): void => {
      const result = resolveBrowserUrl(target, {
        apiOrigin: this.apiOrigin(),
      });

      if (!result.ok) {
        event.preventDefault();
        logger.warn(`Blocked browser navigation (${result.reason}): ${target}`);
      }
    };

    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);

    // 子框架同样不能绕过策略：iframe 里加载应用地址也不行。
    contents.on("will-frame-navigate", (details) => {
      if (details.isMainFrame) {
        return;
      }

      const result = resolveBrowserUrl(details.url, {
        apiOrigin: this.apiOrigin(),
      });

      if (!result.ok) {
        details.preventDefault();
        logger.warn(
          `Blocked browser subframe navigation (${result.reason}): ${details.url}`
        );
      }
    });

    contents.setWindowOpenHandler(({ url }) => {
      // 子窗口留给后面的子窗口管理；这个版本只拒绝并记录。
      const result = resolveBrowserUrl(url, { apiOrigin: this.apiOrigin() });

      logger.warn(
        `Blocked browser popup (${result.ok ? "managed-later" : result.reason}): ${url}`
      );

      return { action: "deny" };
    });
  }

  /** 汇总当前页面状态并推给渲染端。 */
  private publish(managed: ManagedView): void {
    if (this.window.isDestroyed()) {
      return;
    }

    const contents = managed.view.webContents;
    const state: BrowserNavigationState = {
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(),
      title: contents.getTitle(),
      url: contents.getURL(),
    };

    this.window.webContents.send(IPC_CHANNELS.BROWSER_STATE, {
      id: managed.id,
      state,
    });
  }
}

export { isBounds };
