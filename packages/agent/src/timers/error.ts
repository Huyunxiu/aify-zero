/**
 * 定时器的分类错误。
 *
 * 调用方按 `code` 分辨失败原因，不去匹配错误文案；文案可以改，code 是契约。
 */

/** 定时器能报告的失败原因。 */
export type TimerErrorCode = "TIMER_LIMIT_REACHED";

/** 带分类码的定时器错误。 */
export class TimerError extends Error {
  readonly code: TimerErrorCode;

  constructor(message: string, code: TimerErrorCode) {
    super(message);
    this.name = "TimerError";
    this.code = code;
  }
}
