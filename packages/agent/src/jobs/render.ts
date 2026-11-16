import type { JobChunk, JobRead, JobStatus, JobView } from "./types";

/** 给模型看的任务投影：去掉归属、偏移和输出水位。 */
export type PublicJob = {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  /** 运行中的进度行；结算后清空。 */
  progress?: string;
  /** 终态原因；运行中不写。 */
  detail?: string;
  startedAt: number;
  finishedAt?: number;
};

/**
 * 抹掉归属、偏移和上限，只留下模型该知道的事实。
 * @param job - 注册表投影。
 */
export const publicJob = (job: JobView): PublicJob => ({
  id: job.id,
  kind: job.kind,
  label: job.label,
  status: job.status,
  ...(job.progress === undefined ? {} : { progress: job.progress }),
  ...(job.detail === undefined ? {} : { detail: job.detail }),
  startedAt: job.startedAt,
  ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
});

/**
 * 状态行，模型读到的每个任务结果都以它结尾。运行中取进度行，结算后取终态
 * 原因；`note` 是这次调用自己加的说明（例如 `user steered`）。
 * @param job - 任务快照。
 * @param note - 追加在限定语后面的说明。
 */
export const statusLine = (
  job: Pick<PublicJob, "status" | "progress" | "detail">,
  note?: string
): string => {
  const qualifier = [job.detail ?? job.progress, note]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("; ");
  return qualifier.length === 0
    ? `[status: ${job.status}]`
    : `[status: ${job.status}, ${qualifier}]`;
};

/** 丢失输出的提示；有完整输出文件时把路径也交出去。 */
const lostOutputNotice = (spillPaths: readonly string[]): string =>
  `[some output was dropped from memory; full output: ${
    spillPaths.length > 0 ? spillPaths.join(", ") : "(unavailable)"
  }]`;

/**
 * 把一次消费式读取渲染成模型看到的增量：stdout 在前，stderr 合成一段，`log`
 * 通道只给观察者看。游标落在保留窗口之前，或块本身带生产方丢字节的标记时，
 * 补一行丢失提示并给出完整输出文件。
 * @param chunks - 自游标以来的块。
 * @param lossy - 游标是否落在最早保留字节之前。
 * @param spillPaths - 任务当前声明的完整输出文件。
 */
export const renderDelta = (
  chunks: readonly JobChunk[],
  lossy: boolean,
  spillPaths: readonly string[]
): string => {
  const visible = chunks.filter((chunk) => chunk.channel !== "log");
  const out = visible
    .filter((chunk) => chunk.channel !== "stderr")
    .map((chunk) => chunk.text)
    .join("");
  const err = visible
    .filter((chunk) => chunk.channel === "stderr")
    .map((chunk) => chunk.text)
    .join("");
  const separator = out.length > 0 && !out.endsWith("\n") ? "\n" : "";
  const body = `${out}${err.length > 0 ? `${separator}[stderr]\n${err}` : ""}`;
  if (!lossy && !visible.some((chunk) => chunk.gapBefore === true)) {
    return body;
  }
  return `${body}${body.length > 0 && !body.endsWith("\n") ? "\n" : ""}${lostOutputNotice(spillPaths)}`;
};

/**
 * 一次读取的正文：增量，结算后的第一次读取再补上结果。状态行不在这里，
 * 因为裁剪上限时要单独保留它。
 * @param read - 注册表的消费式读取。
 */
export const renderJobBody = (read: JobRead): string => {
  const delta = renderDelta(
    read.chunks,
    read.lossy,
    read.job.output.spillPaths ?? []
  );
  const withResult =
    read.result === undefined
      ? delta
      : `${delta}${delta.length > 0 && !delta.endsWith("\n") ? "\n" : ""}${read.result}`;
  return withResult.length > 0 ? withResult : "(no new output)";
};

/**
 * 一次任务读取的完整模型侧文本：正文加状态行。
 * @param read - 注册表的消费式读取。
 */
export const renderJobRead = (read: JobRead): string => {
  const body = renderJobBody(read);
  return `${body}${body.endsWith("\n") ? "" : "\n"}${statusLine(publicJob(read.job))}`;
};
