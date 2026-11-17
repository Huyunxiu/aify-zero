import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";

import { TapeGate, wallClock } from "./clock.js";
import type { Clock } from "./clock.js";
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

export type TapePlayerOptions = {
  /** 录制带路径。 */
  readonly path: string;
  /** 时间源；缺省是原速。 */
  readonly clock?: Clock;
  /** 播到第几帧就挂起；0 基，指的是已经发出的帧数。 */
  readonly pauseAt?: number;
  /** 挂起时喊一声。 */
  readonly onHold?: (frame: number) => void;
};

/**
 * 按顺序把录制带里的响应放出去。
 *
 * 不按请求内容匹配：一次带工具的回合会发多次请求，顺序本身就是那次交互的
 * 形状；匹配规则只会带来新的复杂度，换不来更真实的行为。
 */
export class TapePlayer {
  readonly #path: string;
  readonly #entries: readonly TapeEntry[];
  readonly #clock: Clock;
  readonly #gate = new TapeGate();
  readonly #pauseAt: number | undefined;
  readonly #onHold: ((frame: number) => void) | undefined;
  #cursor = 0;
  #frames = 0;

  private constructor(
    path: string,
    entries: readonly TapeEntry[],
    clock: Clock,
    options: Pick<TapePlayerOptions, "pauseAt" | "onHold">
  ) {
    this.#path = path;
    this.#entries = entries;
    this.#clock = clock;
    this.#pauseAt = options.pauseAt;
    this.#onHold = options.onHold;
  }

  static async load(options: TapePlayerOptions): Promise<TapePlayer> {
    const items = await loadTape(options.path);
    const entries = items.flatMap((item) =>
      item.kind === "request" ? [item.entry] : []
    );

    return new TapePlayer(options.path, entries, options.clock ?? wallClock(), {
      ...(options.pauseAt === undefined ? {} : { pauseAt: options.pauseAt }),
      ...(options.onHold === undefined ? {} : { onHold: options.onHold }),
    });
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
  get paused(): boolean {
    return this.#gate.paused;
  }

  /** 放行挂起的播放。 */
  release(): void {
    this.#gate.release();
  }

  /**
   * 放一条。录制带用完时回一条供应商错误，和旧的 `replay` 动作保持一致。
   */
  async play(response: ServerResponse): Promise<void> {
    const entry = this.#entries[this.#cursor];

    if (entry === undefined) {
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
    response.writeHead(entry.response.status, entry.response.headers);

    for (const [index, frame] of entry.response.frames.entries()) {
      // 挂起的判据是「已经发出多少帧」，所以自增放在写之后。
      if (this.#pauseAt !== undefined && this.#frames === this.#pauseAt) {
        this.#gate.hold();
        this.#onHold?.(this.#frames);
      }

      await this.#gate.wait();
      await this.#clock.next(index, frame);
      response.write(decodeFrameBytes(frame.bytes));
      this.#frames += 1;
    }

    response.end();
  }
}
