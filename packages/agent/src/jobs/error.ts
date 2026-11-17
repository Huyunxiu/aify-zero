/**
 * 后台任务的分类错误。
 *
 * 调用方按 `code` 分辨失败原因，不去匹配错误文案；文案可以改，code 是契约。
 */

/** 任务注册表能报告的失败原因。 */
export type JobErrorCode =
  | "JOB_NOT_FOUND"
  | "JOB_FOREIGN_SESSION"
  | "JOB_LIMIT_REACHED";

/** 带分类码的任务错误。 */
export class JobError extends Error {
  readonly code: JobErrorCode;

  constructor(message: string, code: JobErrorCode) {
    super(message);
    this.name = "JobError";
    this.code = code;
  }
}
