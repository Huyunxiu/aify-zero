/**
 * 面板标签的取值与纯操作。
 *
 * 标签状态放在 `session-panel.tsx`，这里只留下可以被单测覆盖的纯函数：
 * 打开一个视图时，标签列表要怎么变。
 */

/** 面板能打开的视图。同一个视图同时只有一个标签。 */
export type SessionPanelTab = "files" | "review" | "terminal";

/** 新标签页的标签值；选中时显示视图选择页，不挂具体视图。 */
export const NEW_TAB = "new";

/** 标签栏能选中的值：真实视图或新标签页。 */
export type PanelTabValue = SessionPanelTab | typeof NEW_TAB;

/**
 * 打开一个视图后的标签列表。
 *
 * 已经有这个视图就不再追加；否则先占掉「新标签页」的位置，没有位置就排到最后。
 *
 * @param tabs - 当前标签列表。
 * @param view - 要打开的视图。
 * @returns 新的标签列表；原数组不改。
 */
export function withView(
  tabs: readonly PanelTabValue[],
  view: SessionPanelTab
): PanelTabValue[] {
  if (tabs.includes(view)) {
    return [...tabs];
  }

  const index = tabs.indexOf(NEW_TAB);

  if (index === -1) {
    return [...tabs, view];
  }

  const next = [...tabs];

  next[index] = view;

  return next;
}
