/**
 * 原生视图的投影。
 *
 * 渲染端只决定「该不该显示、显示在哪」，主进程照做。纯函数让可见性规则
 * 能被单测覆盖：面板动画、模态浮层、非当前标签、零尺寸占位都收敛到这里。
 */
import type { BrowserBounds } from "@workspace/shared/browser-protocol";

/** 一次要应用到原生视图上的状态。 */
export type BrowserFrame = {
  readonly bounds: BrowserBounds;
  readonly visible: boolean;
};

/** 投影的输入，全部来自渲染端的界面状态。 */
export type BrowserFrameInput = {
  /** 这个标签是不是当前标签，并且面板没有收起。 */
  readonly active: boolean;
  /** 面板开合动画是否结束。 */
  readonly animationSettled: boolean;
  readonly bounds: BrowserBounds | null;
  /** 是否有模态浮层盖住了面板。 */
  readonly occluded: boolean;
};

/** 投影的输出目标；主进程适配器和测试里的假适配器都实现它。 */
export type BrowserFrameTarget = {
  setBounds(id: string, bounds: BrowserBounds): void;
  setVisible(id: string, visible: boolean): void;
};

/**
 * 由界面状态算出原生视图应有的矩形和显隐。
 *
 * @param input - 界面状态。
 * @returns 要应用的帧；还没有测量结果时为 null。
 */
export function projectBrowserFrame(
  input: BrowserFrameInput
): BrowserFrame | null {
  const { bounds } = input;

  if (bounds === null) {
    return null;
  }

  return {
    bounds,
    visible:
      input.active &&
      input.animationSettled &&
      !input.occluded &&
      bounds.width > 0 &&
      bounds.height > 0,
  };
}

/**
 * 把新的帧应用到视图上，只发变化过的部分。
 *
 * @param target - 视图适配器。
 * @param id - 视图 id。
 * @param applied - 上一次成功应用的帧。
 * @param next - 这一次要应用的帧。
 * @returns 新的已应用帧。
 */
export function applyBrowserFrame(
  target: BrowserFrameTarget,
  id: string,
  applied: BrowserFrame | null,
  next: BrowserFrame | null
): BrowserFrame | null {
  if (next === null) {
    if (applied?.visible === true) {
      target.setVisible(id, false);
    }

    return null;
  }

  const boundsChanged =
    applied === null ||
    applied.bounds.x !== next.bounds.x ||
    applied.bounds.y !== next.bounds.y ||
    applied.bounds.width !== next.bounds.width ||
    applied.bounds.height !== next.bounds.height;

  if (boundsChanged) {
    target.setBounds(id, next.bounds);
  }

  if (applied === null || applied.visible !== next.visible) {
    target.setVisible(id, next.visible);
  }

  return next;
}
