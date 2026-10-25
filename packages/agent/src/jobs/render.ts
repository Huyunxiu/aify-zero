import type { JobChunk, JobRead, JobStatus, JobView } from "./types";

/** 给模型看的任务投影：去掉归属、偏移和输出水位。 */
export type PublicJob = {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  /** 运行中的进度行，或结算后的终态原因。 */
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
  ...(job.detail === undefined ? {} : { detail: job.detail }),
  startedAt: job.startedAt,
  ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
});

/**
 * 状态行，模型读到的每个任务结果都以它结尾。
 * @param job - 任务快照。
 */
export const statusLine = (job: Pick<PublicJob, "status" | "detail">): string =>
  job.detail === undefined
    ? `[status: ${job.status}]`
    : `[status: ${job.status}, ${job.detail}]`;

/**
 * 把一次消费式读取渲染成模型看到的增量：stdout 在前，stderr 合成一段，`log`
 * 通道只给观察者看。字节在读取之前被淘汰时补一行丢失提示。
 * @param chunks - 自游标以来的块。
 * @param lossy - 游标是否落在最早保留字节之前。
 */
const renderDelta = (chunks: readonly JobChunk[], lossy: boolean): string => {
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
  if (!lossy) {
    return body;
  }
  return `${body}${body.length > 0 && !body.endsWith("\n") ? "\n" : ""}[earlier output was lost]`;
};

/**
 * 一次任务读取的完整模型侧文本：增量，结算后的第一次读取再补上结果，最后是
 * 状态行。
 * @param read - 注册表的消费式读取。
 */
export const renderJobRead = (read: JobRead): string => {
  const delta = renderDelta(read.chunks, read.lossy);
  const withResult =
    read.result === undefined
      ? delta
      : `${delta}${delta.length > 0 && !delta.endsWith("\n") ? "\n" : ""}${read.result}`;
  const body = withResult.length > 0 ? withResult : "(no new output)";
  return `${body}${body.endsWith("\n") ? "" : "\n"}${statusLine(publicJob(read.job))}`;
};
