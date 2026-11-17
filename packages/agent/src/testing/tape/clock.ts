import type { TapeFrame } from "./format.js";

/** 一次播放的时间源：决定第 index 帧何时允许发出。 */
export type Clock = {
  next(index: number, frame: TapeFrame): Promise<void>;
};

export type WallClockOptions = {
  /** 相邻帧的最大等待。空闲超过它就截断，默认 2 秒。 */
  readonly capMs?: number;
  /** 播放倍速；2 就是两倍速。最低 0.1。 */
  readonly speed?: number;
};

const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * 原速播放，空闲截断。
 *
 * 整会话录制里一定有大段空闲：人思考、审批等待、离开一会儿。照原样播会废掉，
 * 所以相邻帧的间隔封顶到 `capMs`。
 */
export const wallClock = (options: WallClockOptions = {}): Clock => {
  const capMs = options.capMs ?? 2000;
  const speed = Math.max(0.1, options.speed ?? 1);
  let previous = 0;

  return {
    async next(_index, frame) {
      const gap = Math.max(0, Math.min(frame.at - previous, capMs));
      previous = frame.at;
      await sleep(gap / speed);
    },
  };
};
