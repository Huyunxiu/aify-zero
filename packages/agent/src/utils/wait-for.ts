import { setTimeout as delay } from "node:timers/promises";

/**
 * 等 `ms` 毫秒；`signal` 中止时立刻结束。
 *
 * 只给重试之间的退避用。它不抛错，醒来之后由调用方再查一次 signal：这样
 * 「等完了」和「被中止了」走同一条路，调用方只需要判断一次。
 */
export async function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // 中止不是错误：调用方醒来后会自己查一次 signal。
  }
}
