/**
 * 是否在桌面壳里渲染。
 *
 * 桌面壳的 preload 会同步注入 `aifyDesktop`，浏览器里没有这个对象。布局用它
 * 决定要不要留出窗口装饰占的位置。
 */
export const isDesktopShell =
  typeof window !== "undefined" && window.aifyDesktop !== undefined;
