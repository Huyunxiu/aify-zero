import type { TapeFrame } from "./format.js";

/** 一次播放的时间源：决定第 index 帧何时允许发出。 */
export type Clock = {
  next(index: number, frame: TapeFrame): Promise<void>;
  /** 一条新响应开始：时间基准回到零。帧的 `at` 相对各自的请求。 */
  reset?(): void;
};

export type WallClockOptions = {
  /** 相邻帧的最大等待。空闲超过它就截断，默认 2 秒。 */
  readonly capMs?: number;
  /** 播放倍速；2 就是两倍速。最低 0.1。 */
  readonly speed?: number;
};

export const sleep = async (ms: number): Promise<void> => {
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
    reset() {
      previous = 0;
    },
    async next(_index, frame) {
      const gap = Math.max(0, Math.min(frame.at - previous, capMs));
      previous = frame.at;
      await sleep(gap / speed);
    },
  };
};

/** 闸门的三种状态：全放行、每帧都等、只放一帧。 */
export type GateMode = "run" | "hold" | "step";

/**
 * 挂起闸门：播放器停在某一帧，等一个外部信号才继续。
 *
 * 连接保持打开、不发数据；客户端看到的是「还在生成」，这正是要停住的那一刻。
 */
export class TapeGate {
  #mode: GateMode = "run";
  readonly #waiters: (() => void)[] = [];

  get mode(): GateMode {
    return this.#mode;
  }

  get held(): boolean {
    return this.#mode !== "run";
  }

  /** 挂起：下一帧及之后都等。已经在等的不会被唤醒。 */
  hold(): void {
    this.#mode = "hold";
  }

  /** 放一帧，然后回到挂起。没人在等就留给下一次。 */
  step(): void {
    const resolve = this.#waiters.shift();

    if (resolve === undefined) {
      this.#mode = "step";

      return;
    }

    resolve();
  }

  /** 完全放行，唤醒所有等待者。 */
  release(): void {
    this.#mode = "run";
    for (const resolve of this.#waiters.splice(0)) {
      resolve();
    }
  }

  async wait(): Promise<void> {
    if (this.#mode === "run") {
      return;
    }

    if (this.#mode === "step") {
      this.#mode = "hold";

      return;
    }

    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}
