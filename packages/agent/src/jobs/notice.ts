import { utf8Bytes } from "./limit";
import { publicJob, renderJobBody, statusLine } from "./render";
import type { JobRead, JobView } from "./types";

/** 通知里内联输出的字节上限；超过就只给摘要，让模型自己读。 */
export const INLINE_NOTICE_BYTES = 2048;

/** 标签在通知里的字符上限；命令可能很长，模型手里有任务 id。 */
const MAX_LABEL_CHARS = 120;

/** 一条待投递的完成通知。 */
export type JobNotice = {
  /** 投给模型的正文。 */
  text: string;
  /** 正文是否已经带上未读输出与终态结果。 */
  inline: boolean;
};

/** 标签的第一行，压到通知能承受的长度。 */
const noticeLabel = (label: string): string => {
  const text = label.trimStart();
  const newline = text.indexOf("\n");
  const first = newline === -1 ? text : `${text.slice(0, newline)}…`;
  return first.length <= MAX_LABEL_CHARS
    ? first
    : `${first.slice(0, MAX_LABEL_CHARS - 1)}…`;
};

/** 通知的抬头：任务身份、标签和终态。 */
const noticeHead = (job: JobView): string =>
  `background job ${job.id} (${job.kind}: ${noticeLabel(job.label)}) finished ${statusLine(publicJob(job))}`;

/** 不含输出的兜底通知；放不下时退到最省的写法。 */
const pointerNotice = (job: JobView, limitBytes: number): string => {
  const pointer = `${noticeHead(job)}. Read its output with job-output.`;
  if (utf8Bytes(pointer) <= limitBytes) {
    return pointer;
  }
  const compact = `background job ${job.id} finished. Read it with job-output.`;
  return utf8Bytes(compact) <= limitBytes ? compact : `job ${job.id} finished.`;
};

/**
 * 组一条完成通知。
 *
 * 未读输出放得进上限时才去消费它；放不进就只给摘要，游标留给 `job-output`。
 * 通知正文与用户消息同构，模型不需要第二种消息形状。
 * @param input.job - 结算后的任务投影。
 * @param input.readOutput - 消费式读取；省略表示只能给摘要。
 * @returns 正文与是否内联。
 */
export const composeJobNotice = ({
  job,
  readOutput,
}: {
  job: JobView;
  readOutput?: () => JobRead;
}): JobNotice => {
  const limitBytes = Math.min(
    INLINE_NOTICE_BYTES,
    job.outputLimitBytes ?? Number.POSITIVE_INFINITY
  );
  const head = noticeHead(job);
  // 留出行头与状态行的余量：只有整段输出明显放得下才消费游标。
  if (
    readOutput === undefined ||
    job.output.total > limitBytes - utf8Bytes(head) - 64
  ) {
    return { text: pointerNotice(job, limitBytes), inline: false };
  }

  const read = readOutput();
  const body = renderJobBody(read);
  const text = `${head}.\nOutput:\n${body}`;
  if (utf8Bytes(text) > limitBytes) {
    // 极端情况下放弃内联；游标已经消费，但任务的状态与摘要仍可读。
    return { text: pointerNotice(job, limitBytes), inline: false };
  }
  return { text, inline: true };
};
