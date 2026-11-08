/**
 * 浏览器视图的渲染端适配器。
 *
 * 界面通过这个接口驱动原生视图；接口本身不依赖 Electron，所以测试可以换成
 * 假适配器。浏览器里没有桥，返回 null，入口和视图据此隐藏。
 */
import type {
  BrowserBounds,
  BrowserBridge,
  BrowserStateEvent,
  BrowserViewInit,
} from "@workspace/shared/browser-protocol";

import type { BrowserFrameTarget } from "./browser-frame";

/** 渲染端能对原生视图做的全部事情。 */
export interface BrowserRuntime extends BrowserFrameTarget {
  create(view: BrowserViewInit): Promise<void>;
  destroy(id: string): void;
  navigate(id: string, url: string): Promise<void>;
  back(id: string): void;
  forward(id: string): void;
  reload(id: string): void;
  /** 订阅导航状态；返回取消订阅。 */
  subscribe(listener: (event: BrowserStateEvent) => void): () => void;
}

/**
 * 当前环境里的浏览器运行时。
 *
 * @returns 桌面壳里的适配器；浏览器里为 null。
 */
export function getBrowserRuntime(): BrowserRuntime | null {
  const bridge: BrowserBridge | undefined =
    typeof window === "undefined" ? undefined : window.aifyDesktop?.browser;

  if (bridge === undefined) {
    return null;
  }

  return {
    back: (id) => {
      bridge.back(id);
    },
    create: async (view) => {
      await bridge.create(view);
    },
    destroy: (id) => {
      bridge.destroy(id);
    },
    forward: (id) => {
      bridge.forward(id);
    },
    navigate: async (id, url) => {
      await bridge.navigate(id, url);
    },
    reload: (id) => {
      bridge.reload(id);
    },
    setBounds: (id: string, bounds: BrowserBounds) => {
      bridge.setBounds(id, bounds);
    },
    setVisible: (id: string, visible: boolean) => {
      bridge.setVisible(id, visible);
    },
    subscribe: (listener) => {
      const handle = bridge.onState(listener);

      return () => {
        bridge.offState(handle);
      };
    },
  };
}
