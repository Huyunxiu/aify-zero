import { logger } from "@workspace/shared/logger";

import type { TimerSchedulerState, TimerStore } from "./types";

/**
 * 默认扫描间隔。
 *
 * 60 秒。定时器只保证「不早于」，不保证准时：`afterSeconds: 600` 实际是十到
 * 十一分钟，工具描述里要说清楚。再密一档换不来可感知的精度，只换来无谓的查询。
 */
export const DEFAULT_SCAN_INTERVAL_MS = 60_000;

export type TimerSchedulerOptions = {
  store: TimerStore;
  /**
   * 投递之后唤醒会话。
   *
   * 扫描循环只在事务提交之后调它：在事务里唤醒会让运行器读到还没提交的收件箱。
   */
  wake: (sessionId: string) => void;
  /** 扫描间隔，毫秒；省略时 {@link DEFAULT_SCAN_INTERVAL_MS}。 */
  intervalMs?: number;
  /** 取当前时刻；测试用它推进时钟。 */
  now?: () => number;
  /** 内部告警的落点；测试可以换成收集器。 */
  warn?: (message: string, error?: unknown) => void;
};

/**
 * 定时器的扫描循环。
 *
 * 它只做一件事：把到点的定时器换成收件箱里的待办项，然后叫醒那些会话。跟进
 * 用完就删，日程由存储层在同一事务里推进到下一次——这里不区分两类，只看「投了
 * 几条、要叫醒谁」。它不跑模型，也不碰运行锁：起跑仍然是运行器的事（ADR 0012）。
 */
export class TimerScheduler {
  readonly #store: TimerStore;
  readonly #wake: (sessionId: string) => void;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #warn: (message: string, error?: unknown) => void;

  #handle: ReturnType<typeof setInterval> | undefined;
  /** 正在跑的那次扫描；`stop()` 等它跑完。 */
  #scanning: Promise<void> | undefined;
  #stopped = false;
  #lastScanAt: number | null = null;
  #lastFired = 0;

  constructor(options: TimerSchedulerOptions) {
    this.#store = options.store;
    this.#wake = options.wake;
    this.#intervalMs = options.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#warn =
      options.warn ??
      ((message, error) => {
        logger.warn(message, error);
      });

    if (!Number.isFinite(this.#intervalMs) || this.#intervalMs <= 0) {
      throw new Error(
        `invalid timer scan interval: expected a positive finite number of milliseconds, got ${JSON.stringify(this.#intervalMs)}`
      );
    }
  }

  /**
   * 开始扫描。
   *
   * 启动时先扫一次：进程停机期间到点的定时器要补投，不能等到下一个周期。
   * 重复调用没有副作用。
   */
  start(): void {
    if (this.#handle !== undefined) {
      return;
    }

    this.#stopped = false;
    this.#handle = setInterval(() => {
      void this.#scan();
    }, this.#intervalMs);
    // 一个扫描循环不该拖住进程退出。
    this.#handle.unref?.();

    void this.#scan();
  }

  /** 停止扫描；正在跑的那次让它跑完。 */
  async stop(): Promise<void> {
    this.#stopped = true;

    if (this.#handle !== undefined) {
      clearInterval(this.#handle);
      this.#handle = undefined;
    }

    await this.#scanning;
  }

  /**
   * 只读状态：挂着的定时器数、其中日程的条数、上次扫描的时刻、上次投了几条。
   *
   * 日程条数是总数的一个子集：预算被长期日程吃满和扫描停了是两种故障，一个
   * 总数说不清。
   */
  async state(): Promise<TimerSchedulerState> {
    const counts = await this.#store.countTimers();

    return {
      intervalMs: this.#intervalMs,
      pending: counts.pending,
      pendingSchedules: counts.schedules,
      lastScanAt: this.#lastScanAt,
      lastFired: this.#lastFired,
    };
  }

  /**
   * 扫一次。
   *
   * 上一次还没扫完时直接返回：慢查询不该叠在一起。扫描失败只记日志，循环
   * 继续——一次库锁不该让定时器永久停摆。
   */
  async #scan(): Promise<void> {
    if (this.#stopped || this.#scanning !== undefined) {
      return;
    }

    const running = this.#fire();
    this.#scanning = running;

    try {
      await running;
    } finally {
      this.#scanning = undefined;
    }
  }

  async #fire(): Promise<void> {
    try {
      const now = this.#now();
      const fired = await this.#store.fireDueTimers(now);

      this.#lastScanAt = now;
      this.#lastFired = fired.length;

      if (fired.length === 0) {
        return;
      }

      // 一个会话可能同时到点好几条；唤醒一次就够，运行器会一次领走整批。
      for (const sessionId of new Set(fired.map((timer) => timer.sessionId))) {
        this.#wake(sessionId);
      }
    } catch (error) {
      this.#warn("[timers] scan failed", error);
    }
  }
}

/** 建一个扫描循环。 */
export const createTimerScheduler = (
  options: TimerSchedulerOptions
): TimerScheduler => new TimerScheduler(options);
