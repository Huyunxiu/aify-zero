/**
 * 代码视图的公共设置。
 *
 * 文件视图和改动视图上下摞着同一种内容区：一块自己滚动的代码区域。两边的
 * 主题、底色和滚动方式必须一致，否则切标签页时背景和高亮会跳。
 */
import type { CodeViewReactOptions } from "@pierre/diffs/react";

/** 内容区自己滚动，撑满面板剩下的高度。 */
export const CODE_VIEW_STYLE = { height: "100%", overflow: "auto" } as const;

/** 差异的排布：堆叠（上下）或并排（左右）。 */
export type DiffLayout = "unified" | "split";

/** 默认堆叠：一行占满宽度，长行更好读。 */
export const DEFAULT_DIFF_LAYOUT: DiffLayout = "unified";

/**
 * 存储里的排布换回取值；不认识的一律按默认算。
 *
 * @param stored - `localStorage` 里读到的原文；没有就是 null。
 * @returns 堆叠或并排。
 */
export function diffLayoutOf(stored: string | null): DiffLayout {
  return stored === "split" ? "split" : DEFAULT_DIFF_LAYOUT;
}

/**
 * 两个视图共用的代码视图选项。
 *
 * 上方已经画出路径，这里不再重复一条文件头；内容区跟面板同底色，主题的底色
 * 只服务高亮，不要盖住工作区的背景。
 *
 * @param isDark - `html` 上是否有 `dark` 类。
 * @param layout - 差异怎么排；文件没有差异，用不上这个。
 * @returns 传给 `CodeView` 的选项。
 */
export function codeViewOptions(
  isDark: boolean,
  layout: DiffLayout = DEFAULT_DIFF_LAYOUT
): CodeViewReactOptions<undefined, undefined> {
  return {
    theme: { dark: "pierre-dark", light: "pierre-light" },
    themeType: isDark ? "dark" : "light",
    diffStyle: layout,
    overflow: "wrap",
    disableFileHeader: true,
    unsafeCSS: ":host { --diffs-bg: transparent; }",
  };
}
