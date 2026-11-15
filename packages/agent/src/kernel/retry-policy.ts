import { getErrorMessage } from "@workspace/shared/errors";
import { APICallError, StreamProviderError } from "ai";

/** 一个回合允许的重试次数。 */
export const MAX_RETRIES_PER_TURN = 5;
/** 第一次重试之前等待多久。 */
export const INITIAL_DELAY_MS = 2000;
/** 每重试一次，等待乘几。 */
export const BACKOFF_FACTOR = 2;
/** 单次等待的上限。 */
export const MAX_DELAY_MS = 8000;
/** 超过这个数的 `Retry-After` 不采信：让人等一分钟以上时，退避更合理。 */
const RETRY_AFTER_LIMIT_MS = 60_000;
/** 重试行上原因的长度上限。 */
const REASON_MAX_LENGTH = 80;

/**
 * 第几次重试要等多久：2 / 4 / 8 / 8 / 8 秒。
 *
 * 前两次让瞬时抖动很快恢复，后面的封顶，一个回合的总等待因此有界。
 */
export function backoffDelayMs(index: number): number {
  return Math.min(
    INITIAL_DELAY_MS * BACKOFF_FACTOR ** (index - 1),
    MAX_DELAY_MS
  );
}

/**
 * 供应商自己声明过这次失败能不能再试。
 *
 * 请求发出前的失败是 `APICallError`，流开始后的失败是 `StreamProviderError`，
 * 两者都带 `isRetryable`。网络失败在 provider-utils 里被折成 `APICallError`
 * 并标为可重试；配额不足这类 429 会被供应商标成不可重试。所以这里只看这个
 * 标记，不看状态码。
 */
export function isRetryableError(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    return error.isRetryable;
  }

  if (StreamProviderError.isInstance(error)) {
    return error.isRetryable;
  }

  return false;
}

/**
 * 这次失败要不要重试。
 *
 * 预算是回合级的：用完了就不再重试。溢出单独说：它没有 `isRetryable` 可读，
 * 而压缩成功说明历史已经修好，重试就是它要的收尾。
 */
export function shouldRetry(input: {
  error: unknown;
  /** 这一步的失败是上下文溢出，且压缩已经恢复。 */
  overflowRecovered?: boolean;
  /** 这个回合已经用掉的重试次数。 */
  retriesUsed: number;
}): boolean {
  if (input.retriesUsed >= MAX_RETRIES_PER_TURN) {
    return false;
  }

  if (input.overflowRecovered) {
    return true;
  }

  return isRetryableError(input.error);
}

/**
 * 第 `index` 次重试实际等多久。
 *
 * 供应商给了 `Retry-After` 就照它等，规则与 SDK 一致：`retry-after-ms` 优先；
 * 数值按秒解释；HTTP 日期按差值；超过 60 秒且不小于退避值的头不采信。
 */
export function delayForRetry(
  index: number,
  error: unknown,
  now: number = Date.now()
): number {
  const fallback = backoffDelayMs(index);
  const fromHeader = retryAfterMs(error, now);

  if (fromHeader === undefined) {
    return fallback;
  }

  return fromHeader < RETRY_AFTER_LIMIT_MS || fromHeader < fallback
    ? fromHeader
    : fallback;
}

/** 重试行上的一句话：失败信息的第一行。 */
export function retryReason(error: unknown): string {
  const message = getErrorMessage(error)?.trim() ?? "";
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  const text = firstLine.length > 0 ? firstLine : "unknown error";

  return text.length > REASON_MAX_LENGTH
    ? `${text.slice(0, REASON_MAX_LENGTH - 1)}…`
    : text;
}

/**
 * 响应头里的等待时间。
 *
 * 只有 `APICallError` 带得上响应头；流开始后的 `StreamProviderError` 没有，
 * 那种失败只用退避。
 */
function retryAfterMs(error: unknown, now: number): number | undefined {
  const headers = APICallError.isInstance(error)
    ? error.responseHeaders
    : undefined;
  if (!headers) {
    return undefined;
  }

  const fromMs = parseHeaderMs(headers["retry-after-ms"]);
  if (fromMs !== undefined) {
    return fromMs;
  }

  const raw = headers["retry-after"]?.trim();
  if (!raw) {
    return undefined;
  }

  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(raw);
  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.max(0, date - now);
}

function parseHeaderMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const ms = Number.parseFloat(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
