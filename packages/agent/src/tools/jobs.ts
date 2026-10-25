import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { JobRegistry } from "../jobs/registry";
import { publicJob, renderJobRead, statusLine } from "../jobs/render";
import type { PublicJob } from "../jobs/render";
import type { JobView } from "../jobs/types";
import type { ToolOutput } from "./types";

/** `wait: true` 且没给 timeoutMs 时的等待时长。 */
const DEFAULT_WAIT_MS = 30_000;

/** 任何单次等待的硬上限；模型给得更大就收到这里。 */
const MAX_WAIT_MS = 600_000;

const JOB_ID_DESCRIPTION =
  "Job id returned by the tool that started the background work.";

type JobToolDeps = {
  agentContext: AgentContext;
};

/**
 * 取工具需要的两个依赖。任务工具只在装配了注册表的会话里注册，缺注册表说明
 * 宿主装错了，直接报错比让模型看见一个永远失败的工具好。
 */
const requireJobs = (
  agentContext: AgentContext
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
      "Max wait in milliseconds with wait: true. Defaults to 30 seconds and is capped at 10 minutes."
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

const createJobOutputTool = ({ agentContext }: JobToolDeps) => {
  const { jobs, sessionId } = requireJobs(agentContext);

  return tool<
    JobOutputInput,
    ToolOutput<string, JobOutputMetadata>,
    AgentContext
  >({
    description: JOB_OUTPUT_DESCRIPTION,
    inputSchema: JOB_OUTPUT_INPUT,
    execute: async ({ jobId, wait, timeoutMs }, { abortSignal }) => {
      if (wait === true) {
        // 等待超时返回运行中的状态，所以这里自己管截止时间，而不让工具
        // 超时机制把任务判成失败。
        await jobs.wait(
          jobId,
          Math.min(timeoutMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS),
          sessionId,
          abortSignal
        );
      }
      const read = jobs.read(jobId, sessionId);
      return {
        output: renderJobRead(read),
        code: "ok",
        metadata: { job: publicJob(read.job) },
      };
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
      const killed = jobs.kill(jobId, sessionId, reason);
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
