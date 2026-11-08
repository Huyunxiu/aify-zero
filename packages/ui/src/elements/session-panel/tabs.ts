/**
 * 面板标签的类型与状态操作。
 *
 * 标签是一个个实例，不是视图类型：同一个视图可以开多个标签。文件标签还带
 * 自己的目标文件和根目录名，所以这些状态跟着标签走，互不影响。这里只留下
 * 可以被单测覆盖的纯函数。
 */
import type { FileOpenTarget } from "../markdown-link";
import { targetAfterSelect } from "./target";

/** 面板能打开的视图类型。 */
export type SessionPanelView = "files" | "review" | "terminal" | "browser";

/** 文件标签自己的状态。 */
export type FilesTabState = {
  /** 最近一次来自聊天链接的打开请求；树据此展开并选中。 */
  readonly request?: FileOpenTarget;
  /** 工作区根的目录名；没有打开文件时标签显示它。 */
  readonly rootName: string | null;
  /** 当前打开的文件和高亮区间；路径相对工作区根。 */
  readonly target: FileOpenTarget | null;
};

/** 浏览器视图在标签里的状态。 */
export type BrowserViewTabState = {
  /** 页面标题；标签栏用它代替视图的固定名字。 */
  readonly title: string | null;
};

/** 标签栏里的一个标签；`view` 为 null 时是新标签页。 */
export type PanelTab = {
  /** 浏览器视图的状态；其他标签为 null。 */
  readonly browser: BrowserViewTabState | null;
  /** 文件标签的状态；其他标签为 null。 */
  readonly files: FilesTabState | null;
  readonly id: string;
  readonly view: SessionPanelView | null;
};

/** 面板状态：标签按打开顺序排列，`activeId` 是当前标签。 */
export type PanelState = {
  readonly activeId: string;
  readonly tabs: readonly PanelTab[];
};

/** 面板操作；新标签的 id 由调用方生成，reducer 保持纯函数。 */
export type PanelAction =
  | { readonly id: string; readonly type: "addTab" }
  | { readonly id: string; readonly type: "close" }
  | {
      readonly id: string;
      readonly request: FileOpenTarget;
      readonly type: "openFile";
    }
  | { readonly id: string; readonly type: "select" }
  | {
      readonly id: string;
      readonly type: "openView";
      readonly view: SessionPanelView;
    }
  | {
      readonly id: string;
      readonly path: string | null;
      readonly type: "selectFile";
    }
  | {
      readonly id: string;
      readonly name: string;
      readonly type: "setRootName";
    }
  | {
      readonly id: string;
      readonly title: string | null;
      readonly type: "setBrowserTitle";
    };

/** 一个空的新标签页。 */
function newTab(id: string): PanelTab {
  return { browser: null, files: null, id, view: null };
}

/**
 * 面板的初始状态：一个空的新标签页。
 *
 * @param id - 这个新标签页的 id。
 * @returns 初始状态。
 */
export function initialPanelState(id: string): PanelState {
  return { activeId: id, tabs: [newTab(id)] };
}

/**
 * 把标签放到第一个空闲的新标签页上；没有空闲位置就排到最后。
 *
 * @param tabs - 当前标签列表。
 * @param tab - 要放入的标签。
 * @returns 新的标签列表；原数组不改。
 */
function placeTab(
  tabs: readonly PanelTab[],
  tab: PanelTab
): readonly PanelTab[] {
  const index = tabs.findIndex((item) => item.view === null);

  if (index === -1) {
    return [...tabs, tab];
  }

  const next = [...tabs];

  next[index] = tab;

  return next;
}

/**
 * 换掉列表里的一个标签。
 *
 * @param tabs - 当前标签列表。
 * @param tab - 用来替换的标签，按 id 匹配。
 * @returns 新的标签列表；找不到时返回原列表。
 */
function replaceTab(
  tabs: readonly PanelTab[],
  tab: PanelTab
): readonly PanelTab[] {
  const index = tabs.findIndex((item) => item.id === tab.id);

  if (index === -1) {
    return tabs;
  }

  const next = [...tabs];

  next[index] = tab;

  return next;
}

/** 文件标签的当前状态；还没写过时是一个空状态。 */
function filesOf(tab: PanelTab): FilesTabState {
  return tab.files ?? { rootName: null, target: null };
}

/**
 * 处理一次面板操作。
 *
 * @param state - 当前状态。
 * @param action - 要执行的操作。
 * @returns 新的状态；操作不适用时返回原状态。
 */
export function panelReducer(
  state: PanelState,
  action: PanelAction
): PanelState {
  switch (action.type) {
    case "addTab": {
      const placeholder = state.tabs.find((tab) => tab.view === null);

      if (placeholder !== undefined) {
        return { ...state, activeId: placeholder.id };
      }

      return {
        activeId: action.id,
        tabs: [...state.tabs, newTab(action.id)],
      };
    }
    case "openView": {
      return {
        activeId: action.id,
        tabs: placeTab(state.tabs, {
          browser: null,
          files: null,
          id: action.id,
          view: action.view,
        }),
      };
    }
    case "openFile": {
      const active = state.tabs.find((tab) => tab.id === state.activeId);
      const existing =
        active?.view === "files"
          ? active
          : state.tabs.find((tab) => tab.view === "files");
      const tab: PanelTab = existing ?? {
        browser: null,
        files: null,
        id: action.id,
        view: "files",
      };
      const opened: PanelTab = {
        ...tab,
        files: {
          ...filesOf(tab),
          request: action.request,
          target: action.request,
        },
      };

      return {
        activeId: opened.id,
        tabs:
          existing === undefined
            ? placeTab(state.tabs, opened)
            : replaceTab(state.tabs, opened),
      };
    }
    case "select": {
      if (!state.tabs.some((tab) => tab.id === action.id)) {
        return state;
      }

      return { ...state, activeId: action.id };
    }
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);

      if (index === -1) {
        return state;
      }

      const tabs = state.tabs.filter((tab) => tab.id !== action.id);

      if (tabs.length === 0) {
        // 所有标签都关闭了：回到一个空的新标签页。
        return initialPanelState(action.id);
      }

      return {
        activeId:
          state.activeId === action.id
            ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? action.id)
            : state.activeId,
        tabs,
      };
    }
    case "selectFile": {
      const tab = state.tabs.find((item) => item.id === action.id);

      if (tab === undefined || tab.view !== "files") {
        return state;
      }

      const files = filesOf(tab);
      const target = targetAfterSelect(files.target, action.path);

      if (target === files.target) {
        return state;
      }

      return {
        ...state,
        tabs: replaceTab(state.tabs, {
          ...tab,
          files: { ...files, target },
        }),
      };
    }
    case "setRootName": {
      const tab = state.tabs.find((item) => item.id === action.id);

      if (tab === undefined || tab.view !== "files") {
        return state;
      }

      const files = filesOf(tab);

      if (files.rootName === action.name) {
        return state;
      }

      return {
        ...state,
        tabs: replaceTab(state.tabs, {
          ...tab,
          files: { ...files, rootName: action.name },
        }),
      };
    }
    case "setBrowserTitle": {
      const tab = state.tabs.find((item) => item.id === action.id);

      if (tab === undefined || tab.view !== "browser") {
        return state;
      }

      const browser = tab.browser ?? { title: null };

      if (browser.title === action.title) {
        return state;
      }

      return {
        ...state,
        tabs: replaceTab(state.tabs, {
          ...tab,
          browser: { ...browser, title: action.title },
        }),
      };
    }
    default: {
      return state;
    }
  }
}
