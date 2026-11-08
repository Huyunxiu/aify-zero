/**
 * 模态浮层的遮挡计数。
 *
 * 原生浏览器视图浮在 DOM 之上，任何模态遮罩都盖不住它。打开一个模态就加一，
 * 关闭再减一；计数大于零时视图整体隐藏。计数是进程内状态，订阅用
 * `useSyncExternalStore`，所有视图共用同一份。
 */
import * as React from "react";

let count = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * 声明一个模态浮层正在显示。
 *
 * @returns 关闭浮层时调用的释放函数；重复调用安全。
 */
export function acquireBrowserOcclusion(): () => void {
  count += 1;
  emit();

  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;
    count -= 1;
    emit();
  };
}

function isOccluded(): boolean {
  return count > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** 当前是否有模态浮层。 */
export function useBrowserOccluded(): boolean {
  return React.useSyncExternalStore(subscribe, isOccluded, isOccluded);
}

/** 在模态浮层的内容组件里调用：挂载即计数，卸载即释放。 */
export function useBrowserOcclusion(): void {
  React.useEffect(() => acquireBrowserOcclusion(), []);
}
