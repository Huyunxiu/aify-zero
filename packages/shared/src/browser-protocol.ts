/**
 * 主进程与渲染端之间的浏览器视图协议。
 *
 * 视图由主进程持有（`WebContentsView`），渲染端只知道一个 id 和一个矩形。
 * 命令从渲染端发出，导航状态从主进程推回；两边的类型只写在这里。
 */
import { isBrowserUrlRejection } from "./browser-url";
import type { BrowserUrlRejection } from "./browser-url";

/** 原生视图的矩形，单位是 CSS 像素，相对窗口内容区左上角。 */
export type BrowserBounds = {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
};

/** 地址栏和工具栏需要的一份页面状态。 */
export type BrowserNavigationState = {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly title: string;
  readonly url: string;
};

/** 主进程推给渲染端的导航状态；`id` 是视图 id。 */
export type BrowserStateEvent = {
  readonly id: string;
  readonly state: BrowserNavigationState;
};

/** 创建一个浏览器视图。标签 id 就是视图 id。 */
export type BrowserViewInit = {
  readonly bounds: BrowserBounds;
  readonly id: string;
  /** 浏览器档案按项目分配；没有项目时回退到会话。 */
  readonly projectId: string | null;
  readonly sessionId: string;
};

/**
 * preload 暴露给渲染端的原生视图桥。
 *
 * 主进程和界面各写一份会导致通道形状漂移，所以形状只在这里定义。
 */
export interface BrowserBridge {
  create(view: BrowserViewInit): Promise<void>;
  destroy(id: string): void;
  setBounds(id: string, bounds: BrowserBounds): void;
  setVisible(id: string, visible: boolean): void;
  navigate(id: string, url: string): Promise<void>;
  back(id: string): void;
  forward(id: string): void;
  reload(id: string): void;
  onState(listener: (event: BrowserStateEvent) => void): number;
  offState(id: number): void;
}

/** 一个页面还没开始导航时的状态。 */
export function emptyBrowserState(): BrowserNavigationState {
  return {
    canGoBack: false,
    canGoForward: false,
    loading: false,
    title: "",
    url: "",
  };
}

/**
 * 地址被拒绝时，主进程把原因编码进错误信息，渲染端据此换成自己的文案。
 * 其余错误（例如网络失败）按技术细节原样显示。
 */
export const BROWSER_URL_REJECTION_PREFIX = "browser-url:";

/**
 * 从一个错误信息里取出已知的拒绝原因。
 *
 * IPC 的 invoke 会把主进程的错误包一层（`Error invoking remote method …`），
 * 所以按最后一个前缀出现的位置截断，而不是要求整条信息以它开头。
 *
 * @param message - 错误信息。
 * @returns 已知的拒绝原因；不是地址拒绝时为 null。
 */
export function parseBrowserUrlRejection(
  message: string
): BrowserUrlRejection | null {
  const index = message.lastIndexOf(BROWSER_URL_REJECTION_PREFIX);

  if (index === -1) {
    return null;
  }

  const reason = message
    .slice(index + BROWSER_URL_REJECTION_PREFIX.length)
    .trim();

  return isBrowserUrlRejection(reason) ? reason : null;
}
