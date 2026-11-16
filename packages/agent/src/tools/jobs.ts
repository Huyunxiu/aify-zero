import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { ToolEnvironment } from "../extensions/capabilities";
import { JobError } from "../jobs/error";
import {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  fitJobResult,
  utf8Bytes,
  writeJobResultFile,
} from "../jobs/limit";
import type { JobRegistry } from "../jobs/registry";
import { publicJob, renderJobBody, statusLine } from "../jobs/render";
import type { PublicJob } from "../jobs/render";
import type { JobView } from "../jobs/types";
import type { ToolOutput } from "./types";

/** `wait: true` 且没给 timeoutMs 时的默认等待时长。 */
const DEFAULT_WAIT_MS = 30_000;

/** 任何单次等待的默认硬上限；模型给得更大就收到这里。 */
const MAX_WAIT_MS = 600_000;

const JOB_ID_DESCRIPTION =
  "Job id returned by the tool that started the background work.";

/**
 * 把带分类码的任务错误翻成模型可读的失败：码放在最前面，日志和测试都能按它
 * 分类，模型也仍然看得到原因。
 * @param error - 工具调用里抛出的错误。
 */
const toToolError = (error: unknown): never => {
  if (error instanceof JobError) {
    throw new TypeError(`${error.code}: ${error.message}`);
  }
  throw error;
};

/** 任务工具的等待上限；宿主可以按装配覆盖，省略时用默认值。 */
export type JobToolOptions = {
  /** `wait: true` 且没给 timeoutMs 时的等待时长。 */
  waitTimeoutMs?: number;
  /** 单次等待的硬上限；模型给得更大就收到这里。 */
  maxWaitTimeoutMs?: number;
};

type JobToolDeps = {
  agentContext: ToolEnvironment;
  options?: JobToolOptions;
};

const waitBounds = (
  options: JobToolOptions | undefined
): { defaultMs: number; maxMs: number } => {
  const defaultMs = options?.waitTimeoutMs ?? DEFAULT_WAIT_MS;
  const maxMs = options?.maxWaitTimeoutMs ?? MAX_WAIT_MS;
  if (defaultMs > maxMs) {
    throw new Error(
      `invalid job tool options: waitTimeoutMs (${defaultMs}) exceeds maxWaitTimeoutMs (${maxMs})`
    );
  }
  return { defaultMs, maxMs };
};

/**
 * 取工具需要的两个依赖。任务工具只在装配了注册表的会话里注册，缺注册表说明
 * 宿主装错了，直接报错比让模型看见一个永远失败的工具好。
 */
const requireJobs = (
  agentContext: ToolEnvironment
): { jobs: JobRegistry; sessionId: string } => {
  const { jobs, sessionId } = agentContext;
  if (jobs === undefined) {
    throw new Error(
      "job tools require a job registry on the agent context (agentContext.jobs)"
    );
  }
  return { jobs, sessionId };
};

const JOB_OUTPUT_DESCRIPTION = `
Read a background job started by another tool.

- Returns the output the model has not read yet. A stream job keeps producing; read it again to collect more.
- Set \`wait\` to block until the job finishes or the timeout expires. A timed-out wait returns the running job; it does not kill it.
- Every response ends with \`[status: ...]\`. A finished job hands its final result over exactly once.
`;

const JOB_LIST_DESCRIPTION = `
List your background jobs, running and finished, with their ids, kinds, and statuses.

- Only jobs owned by this session are listed.
- Use it when you no longer remember a job id; the id prefix is the kind.
`;

const JOB_KILL_DESCRIPTION = `
Request cancellation of a running background job.

- The job settles as \`killed\` once its work actually stops, which can take a moment.
- A job that already finished returns its current state instead.
`;

/** 一次读取的模型侧输出与给 UI 的快照。 */
type JobOutputMetadata = {
  job: PublicJob;
};

type JobListMetadata = {
  count: number;
};

type JobKillMetadata = {
  outcome: "cancellation-requested" | "already-finished";
  job: PublicJob;
};

const JOB_OUTPUT_INPUT = z.object({
  jobId: z.string().min(1).describe(JOB_ID_DESCRIPTION),
  wait: z
    .boolean()
    .optional()
    .describe(
      "Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false."
    ),
  timeoutMs: z
    .number()
    .positive()
    .optional()
    .describe(
      "Max wait in milliseconds with wait: true. Defaults to and is capped by the task tool configuration."
    ),
});

const JOB_LIST_INPUT = z.object({});

const JOB_KILL_INPUT = z.object({
  jobId: z.string().min(1).describe(JOB_ID_DESCRIPTION),
  reason: z
    .string()
    .optional()
    .describe(
      "Optional short reason, recorded on the job and forwarded to the cancelled work."
    ),
});

type JobOutputInput = z.infer<typeof JOB_OUTPUT_INPUT>;
type JobListInput = z.infer<typeof JOB_LIST_INPUT>;
type JobKillInput = z.infer<typeof JOB_KILL_INPUT>;

const createJobOutputTool = ({ agentContext, options }: JobToolDeps) => {
  const { jobs, sessionId } = requireJobs(agentContext);
  const { defaultMs, maxMs } = waitBounds(options);

  return tool<
    JobOutputInput,
    ToolOutput<string, JobOutputMetadata>,
    AgentContext
  >({
    description: JOB_OUTPUT_DESCRIPTION,
    inputSchema: JOB_OUTPUT_INPUT,
    execute: async ({ jobId, wait, timeoutMs }, { abortSignal }) => {
      // 这次调用会自己把终态交给模型；这期间结算的任务不再另发通知。
      let release: (() => void) | undefined;
      try {
        release = jobs.beginCollect(jobId, sessionId);
        let steered = false;
        if (wait === true) {
          // 等待超时返回运行中的状态，所以这里自己管截止时间，而不让工具
          // 超时机制把任务判成失败。用户插话时也提前返回，任务继续跑。
          const interruption = new AbortController();
          const unsubscribe = agentContext.steering?.subscribe(() => {
            steered = true;
            interruption.abort();
          });
          try {
            await jobs.wait(
              jobId,
              Math.min(timeoutMs ?? defaultMs, maxMs),
              sessionId,
              abortSignal === undefined
                ? interruption.signal
                : AbortSignal.any([abortSignal, interruption.signal])
            );
          } catch (error: unknown) {
            // 只吞掉自己制造的打断；调用方中止照旧传播。
            if (!interruption.signal.aborted || abortSignal?.aborted === true) {
              throw error;
            }
          } finally {
            unsubscribe?.();
          }
        }
        const read = jobs.read(jobId, sessionId);
        // 模型已经拿到这个任务的输出，还没送达的通知没有意义了。
        jobs.withdrawNotice(jobId);
        const job = publicJob(read.job);
        // 打断发生在任务还在跑的时候：状态行说明这次读取为什么提前返回。
        const note =
          steered && (job.status === "running" || job.status === "stopping")
            ? "user steered"
            : undefined;
        const limitBytes =
          read.job.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
        const body = renderJobBody(read);
        const suffix = `${body.endsWith("\n") ? "" : "\n"}${statusLine(job, note)}`;
        // 超出上限才落盘：完整结果要么已经在生产方的输出文件里，要么现在写一份。
        const spillPath =
          utf8Bytes(`${body}${suffix}`) > limitBytes
            ? (read.job.output.spillPaths?.[0] ??
              writeJobResultFile({
                dir: agentContext.sessionDir,
                jobId,
                text: `${body}${suffix}`,
              }))
            : undefined;
        const fitted = fitJobResult({ body, suffix, limitBytes, spillPath });
        return {
          output: fitted.text,
          code: "ok" as const,
          metadata: { job },
        };
      } catch (error: unknown) {
        return toToolError(error);
      } finally {
        release?.();
      }
    },
    toModelOutput({ output }) {
      return { type: "text", value: output.output };
    },
  });
};

const createJobListTool = ({ agentContext }: JobToolDeps) => {
  const { jobs, sessionId } = requireJobs(agentContext);

  return tool<JobListInput, ToolOutput<string, JobListMetadata>, AgentContext>({
    description: JOB_LIST_DESCRIPTION,
    inputSchema: JOB_LIST_INPUT,
    execute: () => {
      const owned = jobs.list(sessionId);
      return {
        output:
          owned.length === 0
            ? "(no background jobs)"
            : owned.map((job) => renderRow(job)).join("\n"),
        code: "ok" as const,
        metadata: { count: owned.length },
      };
    },
    toModelOutput({ output }) {
      return { type: "text", value: output.output };
    },
  });
};

const createJobKillTool = ({ agentContext }: JobToolDeps) => {
  const { jobs, sessionId } = requireJobs(agentContext);

  return tool<JobKillInput, ToolOutput<string, JobKillMetadata>, AgentContext>({
    description: JOB_KILL_DESCRIPTION,
    inputSchema: JOB_KILL_INPUT,
    execute: ({ jobId, reason }) => {
      try {
        // 取消确认是固定短文案，且以任务 id 开头：不按任务上限裁剪，裁掉 id
        // 会让这条结果无法对应到任务。
        // 来源是模型自己：结算通知不该重复这条结果。
        const killed = jobs.kill(jobId, sessionId, reason, "model");
        const outcome =
          killed === "requested"
            ? ("cancellation-requested" as const)
            : ("already-finished" as const);
        const job = publicJob(jobs.get(jobId, sessionId));
        return {
          output:
            outcome === "already-finished"
              ? `job ${jobId} had already finished ${statusLine(job)}`
              : `requested cancellation of job ${jobId}`,
          code: "ok" as const,
          metadata: { outcome, job },
        };
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
    toModelOutput({ output }) {
      return { type: "text", value: output.output };
    },
  });
};

/** 列表里的一行：id、kind、状态和标签。 */
const renderRow = (job: JobView): string =>
  `${job.id} [${job.kind}] ${job.status} — ${job.label}`;

/**
 * 三个与任务种类无关的控制工具。它们只认注册表里的 id，所以 bash、PTY 或者
 * 后续任何生产方共用同一套读取、列表和取消入口。
 * @param props - 持有注册表与会话 id 的上下文。
 */
export const createJobTools = (props: JobToolDeps) => ({
  "job-output": createJobOutputTool(props),
  "job-list": createJobListTool(props),
  "job-kill": createJobKillTool(props),
});

export type JobOutputToolType = ReturnType<typeof createJobOutputTool>;
export type JobListToolType = ReturnType<typeof createJobListTool>;
export type JobKillToolType = ReturnType<typeof createJobKillTool>;
export type JobTools = ReturnType<typeof createJobTools>;
