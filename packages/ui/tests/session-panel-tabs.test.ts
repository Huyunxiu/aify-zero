import { describe, expect, test } from "vitest";

import {
  initialPanelState,
  panelReducer,
} from "../src/elements/session-panel/tabs";
import type {
  PanelAction,
  PanelState,
} from "../src/elements/session-panel/tabs";

/** 依次执行多个操作。 */
function run(state: PanelState, ...actions: PanelAction[]): PanelState {
  let current = state;

  for (const action of actions) {
    current = panelReducer(current, action);
  }

  return current;
}

/** 一个标签的文件状态。 */
function filesOf(state: PanelState, id: string) {
  return state.tabs.find((tab) => tab.id === id)?.files;
}

/** 一个标签的浏览器状态。 */
function browserOf(state: PanelState, id: string) {
  return state.tabs.find((tab) => tab.id === id)?.browser;
}

/** 标签栏当前的值。 */
function idsOf(state: PanelState): string[] {
  return state.tabs.map((tab) => tab.id);
}

describe("panel tabs", () => {
  test("choosing a view turns the new-tab page into that view", () => {
    const state = panelReducer(initialPanelState("new"), {
      id: "new",
      type: "openView",
      view: "files",
    });

    expect(state.activeId).toBe("new");
    expect(state.tabs).toStrictEqual([
      { browser: null, files: null, id: "new", view: "files" },
    ]);
  });

  test("a browser tab keeps the id it was opened with", () => {
    const state = panelReducer(initialPanelState("new"), {
      id: "browser-1",
      type: "openView",
      view: "browser",
    });

    expect(state.activeId).toBe("browser-1");
    expect(state.tabs).toStrictEqual([
      { browser: null, files: null, id: "browser-1", view: "browser" },
    ]);
  });

  test("a browser title belongs to one tab", () => {
    const state = run(
      initialPanelState("new"),
      { id: "a", type: "openView", view: "browser" },
      { id: "b", type: "openView", view: "browser" },
      { id: "a", title: "Example", type: "setBrowserTitle" }
    );

    expect(browserOf(state, "a")?.title).toBe("Example");
    expect(browserOf(state, "b")).toBeNull();
  });

  test("a browser title is ignored outside a browser tab", () => {
    const state = run(
      initialPanelState("new"),
      { id: "a", type: "openView", view: "files" },
      { id: "a", title: "Example", type: "setBrowserTitle" }
    );

    expect(browserOf(state, "a")).toBeNull();
  });

  test("the same view can open more than once", () => {
    const state = run(
      initialPanelState("new"),
      { id: "a", type: "openView", view: "files" },
      { id: "b", type: "addTab" },
      { id: "b", type: "openView", view: "files" }
    );

    expect(idsOf(state)).toStrictEqual(["a", "b"]);
    expect(state.tabs.map((tab) => tab.view)).toStrictEqual(["files", "files"]);
    expect(state.activeId).toBe("b");
  });

  test("addTab keeps a single empty page", () => {
    const state = run(initialPanelState("new"), { id: "next", type: "addTab" });

    expect(idsOf(state)).toStrictEqual(["new"]);
    expect(state.activeId).toBe("new");
  });

  test("closing the active tab activates a neighbor", () => {
    const state = run(
      initialPanelState("new"),
      { id: "a", type: "openView", view: "files" },
      { id: "b", type: "openView", view: "terminal" },
      { id: "c", type: "openView", view: "review" },
      { id: "b", type: "select" },
      { id: "b", type: "close" }
    );

    expect(idsOf(state)).toStrictEqual(["a", "c"]);
    expect(state.activeId).toBe("c");
  });

  test("closing the last tab returns to a new-tab page", () => {
    const state = run(
      initialPanelState("new"),
      { id: "a", type: "openView", view: "files" },
      { id: "a", type: "close" }
    );

    expect(state.tabs).toStrictEqual([
      { browser: null, files: null, id: "a", view: null },
    ]);
    expect(state.activeId).toBe("a");
  });

  test("a file link opens in the active files tab", () => {
    const request = { path: "src/a.ts" };
    const state = run(
      initialPanelState("new"),
      { id: "a", type: "openView", view: "files" },
      { id: "b", type: "openView", view: "terminal" },
      { id: "a", type: "select" },
      { id: "next", request, type: "openFile" }
    );

    expect(idsOf(state)).toStrictEqual(["a", "b"]);
    expect(state.activeId).toBe("a");
    expect(filesOf(state, "a")?.target).toBe(request);
    expect(filesOf(state, "a")?.request).toBe(request);
  });

  test("a file link falls back to the first files tab", () => {
    const request = { path: "src/b.ts" };
    const state = run(
      initialPanelState("new"),
      { id: "a", type: "openView", view: "files" },
      { id: "b", type: "openView", view: "terminal" },
      { id: "next", request, type: "openFile" }
    );

    expect(idsOf(state)).toStrictEqual(["a", "b"]);
    expect(state.activeId).toBe("a");
    expect(filesOf(state, "a")?.request).toBe(request);
    expect(filesOf(state, "b")).toBeNull();
  });

  test("a file link opens a files tab when none exists", () => {
    const request = { path: "src/c.ts" };
    const state = run(
      initialPanelState("new"),
      { id: "review", type: "openView", view: "review" },
      { id: "next", type: "addTab" },
      { id: "files", request, type: "openFile" }
    );

    expect(idsOf(state)).toStrictEqual(["review", "files"]);
    expect(state.activeId).toBe("files");
    expect(filesOf(state, "files")?.target).toBe(request);
  });

  test("a file link keeps the root name already loaded", () => {
    const state = run(
      initialPanelState("new"),
      { id: "a", type: "openView", view: "files" },
      { id: "a", name: "aify-zero", type: "setRootName" },
      { id: "next", request: { path: "src/a.ts" }, type: "openFile" }
    );

    expect(filesOf(state, "a")?.rootName).toBe("aify-zero");
  });

  test("file tabs keep their own target", () => {
    const state = run(
      initialPanelState("new"),
      { id: "a", type: "openView", view: "files" },
      { id: "b", type: "addTab" },
      { id: "b", type: "openView", view: "files" },
      { id: "a", path: "src/a.ts", type: "selectFile" }
    );

    expect(filesOf(state, "a")?.target).toStrictEqual({ path: "src/a.ts" });
    expect(filesOf(state, "b")).toBeNull();
  });

  test("selecting the same file keeps its range", () => {
    const request = { endLine: 3, line: 1, path: "src/a.ts" };
    const state = run(
      initialPanelState("new"),
      { id: "a", type: "openView", view: "files" },
      { id: "next", request, type: "openFile" },
      { id: "a", path: "src/a.ts", type: "selectFile" }
    );

    expect(filesOf(state, "a")?.target).toBe(request);
  });

  test("closing a files tab drops its state", () => {
    const state = run(
      initialPanelState("new"),
      { id: "a", type: "openView", view: "files" },
      { id: "b", type: "openView", view: "terminal" },
      { id: "a", path: "src/a.ts", type: "selectFile" },
      { id: "a", type: "close" }
    );

    expect(idsOf(state)).toStrictEqual(["b"]);
    expect(filesOf(state, "a")).toBeUndefined();
  });
});
