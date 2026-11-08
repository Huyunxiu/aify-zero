/**
 * 面板里的文件树：它长什么样，以及怎么选。
 *
 * 树自带一份只认系统偏好的配色，这里把它接到应用的设计令牌上，深浅色才会跟着
 * `html` 上的 class 走。条目句柄只提供累加的 `select()`，这里补上「只选这一个」
 * 的语义，和行点击一致。两件事都是对 `@pierre/trees` 的适配，所以放在一处。
 */
import type { FileTree } from "@pierre/trees";
import type { CSSProperties } from "react";

const TREE_THEME = {
  "--trees-bg-override": "var(--background)",
  "--trees-bg-muted-override": "var(--muted)",
  "--trees-border-color-override": "var(--border)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-scrollbar-thumb-override": "var(--border)",
  "--trees-search-bg-override": "var(--muted)",
  "--trees-search-fg-override": "var(--foreground)",
  "--trees-selected-bg-override": "var(--accent)",
  "--trees-selected-fg-override": "var(--accent-foreground)",
  "--trees-padding-inline": "4px",
} as CSSProperties;

/**
 * 树撑满容器，并且和当前深浅色一致。
 *
 * @param isDark - `html` 上是否有 `dark` 类。
 * @returns 传给 `FileTree` 的样式。
 */
export function treeStyle(isDark: boolean): CSSProperties {
  return {
    ...TREE_THEME,
    colorScheme: isDark ? "dark" : "light",
    height: "100%",
  };
}

/**
 * 让树里只剩一个选中项，和行点击的单击语义一致。
 *
 * 从聊天链接跳过来时要先清空，否则上一次选中的文件会和这一次选中的文件或目录
 * 同时高亮。
 *
 * @param model - 树模型。
 * @param path - 要选中的路径；目录带结尾 `/`。
 */
export function selectOnlyPath(model: FileTree, path: string): void {
  for (const selected of model.getSelectedPaths()) {
    if (selected !== path) {
      model.getItem(selected)?.deselect();
    }
  }

  model.getItem(path)?.select();
}
