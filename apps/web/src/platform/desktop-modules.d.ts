/**
 * 桌面壳构建时由 Vite define 注入；浏览器构建为 false。
 */
declare const __AIFY_DESKTOP__: boolean;

/**
 * 浏览器构建里 `@desktop` 只解析到这一处动态 import（桌面构建才真正带上
 * IPC 客户端）。这里刻意只声明用得到的 `initialize`：真实模块会顺着
 * `./router` 把 electron 的类型拖进 apps/web，而浏览器应用不该依赖它。
 * 用到其他方法时，宁可在这里补一行，也不要让 web 依赖 electron。
 */
declare module "@desktop/ipc/manager" {
  export const ipc: { initialize: () => void };
}
