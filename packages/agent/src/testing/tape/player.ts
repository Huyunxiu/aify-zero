import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";

import { sleep, TapeGate, wallClock } from "./clock.js";
import type { Clock, GateMode } from "./clock.js";
import { decodeFrameBytes, parseTapeLine, TAPE_VERSION } from "./format.js";
import type { TapeEntry, TapeItem } from "./format.js";

/** 读一份录制带；头不对就拒绝，不做静默降级。 */
export const loadTape = async (path: string): Promise<TapeItem[]> => {
  const text = await readFile(path, "utf-8");
  const items = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parseTapeLine(line));
  const [header] = items;

  if (header?.kind !== "header") {
    throw new Error(`tape ${path}: first line is not a header`);
  }

  if (header.version !== TAPE_VERSION) {
    throw new Error(
      `tape ${path}: unsupported version ${String(header.version)}`
    );
  }

  return items;
};

/** 一条响应，连同它在时间轴上的位置。 */
type ScheduledEntry = {
  readonly at: number;
  readonly entry: TapeEntry;
};

export type TapePlayerOptions = {
  /** 录制带路径。 */
  readonly path: string;
  /** 时间源；缺省是原速。 */
  readonly clock?: Clock;
  /** 播到第几帧就挂起；0 基，指的是已经发出的帧数。 */
  readonly holdAt?: number;
  /** 挂起时喊一声。 */
  readonly onHold?: (frame: number) => void;
};

/** 播放器的当前状态；给控制面与测试看。 */
export type TapePlayerState = {
  readonly tape: string;
  readonly position: number;
  readonly remaining: number;
  readonly frames: number;
  readonly mode: GateMode;
  readonly held: boolean;
};

/**
 * 按顺序把录制带里的响应放出去。
 *
 * 不按请求内容匹配：一次带工具的回合会发多次请求，顺序本身就是那次交互的
 * 形状；匹配规则只会带来新的复杂度，换不来更真实的行为。
 */
export class TapePlayer {
  readonly #path: string;
  readonly #entries: readonly ScheduledEntry[];
  readonly #clock: Clock;
  readonly #gate = new TapeGate();
  readonly #holdAt: number | undefined;
  readonly #onHold: ((frame: number) => void) | undefined;
  #cursor = 0;
  #frames = 0;
  #busy = false;

  private constructor(
    path: string,
    entries: readonly ScheduledEntry[],
    clock: Clock,
    options: Pick<TapePlayerOptions, "holdAt" | "onHold">
  ) {
    this.#path = path;
    this.#entries = entries;
    this.#clock = clock;
    this.#holdAt = options.holdAt;
    this.#onHold = options.onHold;
  }

  static async load(options: TapePlayerOptions): Promise<TapePlayer> {
    const items = await loadTape(options.path);
    const entries = items
      .flatMap((item) =>
        item.kind === "request" ? [{ at: item.at, entry: item.entry }] : []
      )
      // 文件是追加写的，行序等于「响应完成的顺序」。时间轴按到达排，所以这里
      // 必须重排一次，否则先完成的短请求会抢到长请求的位置。
      .toSorted((left, right) => left.at - right.at);

    return new TapePlayer(options.path, entries, options.clock ?? wallClock(), {
      ...(options.holdAt === undefined ? {} : { holdAt: options.holdAt }),
      ...(options.onHold === undefined ? {} : { onHold: options.onHold }),
    });
  }

  /** 这份带从哪来。 */
  get path(): string {
    return this.#path;
  }

  /** 还有几条没放。 */
  get remaining(): number {
    return this.#entries.length - this.#cursor;
  }

  /** 已经放到第几条。 */
  get position(): number {
    return this.#cursor;
  }

  /** 已经发出多少帧。 */
  get frames(): number {
    return this.#frames;
  }

  /** 现在挂着没有。 */
  get held(): boolean {
    return this.#gate.held;
  }

  /** 有没有一条响应正在往外写。 */
  get busy(): boolean {
    return this.#busy;
  }

  /** 控制面要的那几个数。 */
  state(): TapePlayerState {
    return {
      tape: this.#path,
      position: this.#cursor,
      remaining: this.remaining,
      frames: this.#frames,
      mode: this.#gate.mode,
      held: this.#gate.held,
    };
  }

  /** 挂起：下一帧起都等。 */
  hold(): void {
    this.#gate.hold();
  }

  /** 放一帧，然后回到挂起。 */
  step(): void {
    this.#gate.step();
  }

  /** 完全放行。 */
  resume(): void {
    this.#gate.release();
  }

  /**
   * 放一条。录制带用完时回一条供应商错误，和旧的 `replay` 动作保持一致。
   */
  async play(response: ServerResponse): Promise<void> {
    const scheduled = this.#entries[this.#cursor];

    if (scheduled === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: `fake provider: tape ${this.#path} is used up`,
          },
        })
      );
      return;
    }

    this.#cursor += 1;
    this.#busy = true;
    response.writeHead(
      scheduled.entry.response.status,
      scheduled.entry.response.headers
    );

    try {
      // 帧的时刻相对各自的请求，所以每换一条响应，时间基准都要归零。
      this.#clock.reset?.();

      for (const [index, frame] of scheduled.entry.response.frames.entries()) {
        // 挂起的判据是「已经发出多少帧」，所以自增放在写之后。
        if (this.#holdAt !== undefined && this.#frames === this.#holdAt) {
          this.#gate.hold();
          this.#onHold?.(this.#frames);
        }

        await this.#gate.wait();
        await this.#clock.next(index, frame);
        response.write(decodeFrameBytes(frame.bytes));
        this.#frames += 1;
      }

      // 最后一帧到响应结束之间也可能有间隔，照录制的来。
      await sleep(scheduled.entry.response.tailMs);
    } finally {
      this.#busy = false;
    }

    response.end();
  }
}
