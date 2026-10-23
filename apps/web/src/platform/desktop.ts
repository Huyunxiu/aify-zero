/**
 * 桌面壳的 preload 会注入 `aifyDesktop` 标记。浏览器里没有它，因此这一段
 * 永远不会去加载 desktop 的 IPC 客户端；`__AIFY_DESKTOP__` 是构建期常量，
 * 浏览器构建会把整个分支（包括动态 import）摇掉。
 */
export const initDesktopIpc = async (): Promise<void> => {
  if (!(__AIFY_DESKTOP__ && "aifyDesktop" in window)) {
    return;
  }

  const { ipc } = await import("@desktop/ipc/manager");
  ipc.initialize();
};
