import { stat } from "node:fs/promises";

import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../../agent-context";
import type { JobOutcome } from "../../jobs/types";
import { resolveToolPath } from "../../utils/fs-util";
import type { ToolOutput } from "../types";
import { createShellStreamBuffer } from "./background";
import { runShell } from "./exec";
import type { ShellRunResult } from "./exec";
import type { ShellOutputSnapshot } from "./output";
import { ShellOutputCollector } from "./output";

/** Default foreground timeout, matching the previous bash tool. */
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

export interface ShellProgram {
  /** Complete argv, with the executable first. */
  argv: (command: string) => string[];
  /** Environment overrides for this dialect (terminal noise, pagers, …). */
  env: NodeJS.ProcessEnv;
}

export interface ShellToolOptions {
  description: string;
  agentContext: AgentContext;
  /** 生产方种类，也是后台任务 id 的前缀（`bash`、`powershell`）。 */
  kind: string;
  /** Resolved lazily so a missing executable reports on the call, not on load. */
  program: () => ShellProgram;
}

/** 一次前台调用的结局，状态行和 UI 的行摘要都从这里读。 */
export type ShellForegroundMetadata = {
  kind: "foreground";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** `timedOut` under the tool's historical name. */
  timeout: boolean;
  aborted: boolean;
  timeoutMs: number;
  durationMs: number;
  truncated: boolean;
  spillPath?: string;
};

/** 一次后台调用只交出一个 id；工作本身归任务运行时。 */
export type ShellBackgroundMetadata = {
  kind: "background";
  jobId: string;
  cwd: string;
};

export type ShellToolMetadata =
  | ShellForegroundMetadata
  | ShellBackgroundMetadata;

export type ShellToolOutput = ToolOutput<string, ShellToolMetadata>;

type ShellToolInput = {
  command: string;
  timeout?: number;
  workdir?: string;
  description: string;
  run_in_background?: boolean;
};

const createShellToolSchema = (agentContext: AgentContext) => {
  const schema = z.object({
    command: z.string().trim().min(1).describe("The shell command to execute"),
    timeout: z
      .number()
      .positive()
      .optional()
      .describe(
        `Optional timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS / 1000} seconds)`
      ),
    workdir: z
      .string()
      .optional()
      .describe(
        `The working directory to run the command in. Defaults to ${agentContext.primaryProjectDir}. Use this instead of 'cd' commands.`
      ),
    description: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies"
      ),
  });
  // 后台执行只在装配了任务注册表的会话里存在：没有注册表就没有工具能收走
  // 那个 id，schema 也就不该向模型许诺它。
  if (agentContext.jobs === undefined) {
    return schema;
  }
  return schema.extend({
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        "Run the command in the background and return a job id immediately. Read it with job-output; stop it with job-kill. No timeout applies."
      ),
  });
};

/**
 * Build one model-facing shell tool over the shared kernel.
 *
 * The result body carries the retained output; the model-facing projection
 * additionally carries the status markers (timeout, abort, signal, exit code).
 * A non-zero exit is an ordinary result — the UI row reads its metadata rather
 * than treating the call as failed.
 */
export const createShellTool = ({
  description,
  agentContext,
  kind,
  program,
}: ShellToolOptions): Tool<ShellToolInput, ShellToolOutput, AgentContext> =>
  tool<ShellToolInput, ShellToolOutput, AgentContext>({
    description,
    inputSchema: createShellToolSchema(agentContext),
    execute: async (
      { command, timeout, workdir, run_in_background },
      { abortSignal }
    ) => {
      const resolvedTimeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
      const cwd = resolveToolPath(
        workdir ?? agentContext.primaryProjectDir,
        agentContext.primaryProjectDir
      ).absolute;
      await assertWorkingDirectory(cwd);

      const resolved = program();
      const [file, ...args] = resolved.argv(command);
      if (file === undefined) {
        throw new Error("The shell program resolved to an empty argv.");
      }

      if (run_in_background === true) {
        // 先解析再登记：命令跑起来之后，这个调用就不再等它了。
        return startBackgroundCommand({
          agentContext,
          kind,
          command,
          cwd,
          file,
          args,
          env: { ...process.env, ...resolved.env },
        });
      }

      const collector = new ShellOutputCollector({
        dir: agentContext.sessionDir,
      });

      try {
        const run = await runShell({
          file,
          args,
          cwd,
          env: { ...process.env, ...resolved.env },
          timeoutMs: resolvedTimeoutMs,
          signal: abortSignal,
          onData: (channel, chunk) => {
            collector.push(channel, chunk);
          },
        });
        const snapshot = await collector.finish();
        return {
          output: renderShellResult(snapshot),
          code: "ok",
          metadata: {
            kind: "foreground",
            exitCode: run.exitCode,
            signal: run.signal,
            timeout: run.timedOut,
            aborted: run.aborted,
            timeoutMs: resolvedTimeoutMs,
            durationMs: run.durationMs,
            truncated: snapshot.truncated,
            ...(snapshot.spillPath === undefined
              ? {}
              : { spillPath: snapshot.spillPath }),
          },
        };
      } catch (error) {
        // Close the spill file even though this call's output is discarded.
        await Promise.allSettled([collector.finish()]);
        throw error;
      }
    },
    toModelOutput: ({ output }) => {
      if (output.code === "error") {
        return { type: "error-text", value: output.output };
      }
      const markers = shellStatusMarkers(output.metadata);
      return {
        type: "text",
        value:
          markers.length === 0
            ? output.output
            : `${output.output}\n${markers.join("\n")}`,
      };
    },
  });

type BackgroundCommandProps = {
  agentContext: AgentContext;
  kind: string;
  command: string;
  cwd: string;
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

/**
 * Register the command as a job and return its id at once.
 *
 * The job owns the process from here: the call's own abort signal is not wired
 * to it, so stopping the turn does not kill work the model asked to keep. Only
 * `job-kill` (or disposal of the owner) cancels it.
 * @param props - 已经解析好的命令和目标目录。
 */
function startBackgroundCommand({
  agentContext,
  kind,
  command,
  cwd,
  file,
  args,
  env,
}: BackgroundCommandProps): ShellToolOutput {
  const { jobs, sessionId } = agentContext;
  if (jobs === undefined) {
    throw new Error(
      "background execution is unavailable: no job registry in this composition"
    );
  }
  const buffer = createShellStreamBuffer();
  const controller = new AbortController();
  const jobId = jobs.start({
    kind,
    label: command,
    owner: sessionId,
    output: buffer.sources,
    run: () => ({
      cancel: () => {
        controller.abort();
      },
      done: runBackgroundCommand({ buffer, controller, file, args, cwd, env }),
    }),
  });
  return {
    output: `started background job ${jobId}\nRead it with job-output and stop it with job-kill.`,
    code: "ok",
    metadata: { kind: "background", jobId, cwd },
  };
}

type BackgroundRunProps = {
  buffer: ReturnType<typeof createShellStreamBuffer>;
  controller: AbortController;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/**
 * Run the command without a deadline until it exits or is cancelled.
 * @param props - 输出缓冲、取消信号和已经解析好的命令。
 */
function runBackgroundCommand({
  buffer,
  controller,
  file,
  args,
  cwd,
  env,
}: BackgroundRunProps): Promise<JobOutcome> {
  return runShell({
    file,
    args,
    cwd,
    env,
    signal: controller.signal,
    onData: (channel, chunk) => {
      buffer.push(channel, chunk);
    },
  }).then(
    (run) => {
      buffer.close();
      return backgroundOutcome(run);
    },
    (error: unknown): JobOutcome => {
      buffer.close();
      return { status: "failed", detail: String(error) };
    }
  );
}

/**
 * A cancelled command settles `killed`; everything else is `completed` with the
 * exit code, exactly like the foreground rendering reports a non-zero exit as
 * an ordinary result rather than a failure.
 * @param run - 子进程的结算结果。
 */
function backgroundOutcome(run: ShellRunResult): JobOutcome {
  return run.aborted
    ? { status: "killed", detail: "cancelled" }
    : { status: "completed", detail: `exit code: ${run.exitCode ?? 0}` };
}

/** Fail before spawning when the requested directory is unusable. */
async function assertWorkingDirectory(cwd: string): Promise<void> {
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) {
      throw new Error(`Working directory is not a directory: ${cwd}`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Working directory is not a directory: ${cwd}`
    ) {
      throw error;
    }
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT") {
      throw new Error(`Working directory does not exist: ${cwd}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * The model-facing body: stdout, an `[stderr]` section, and a truncation notice
 * naming the spill file. Status markers are not part of it — they are facts
 * about how the call ended, added by `toModelOutput`.
 */
function renderShellResult(snapshot: ShellOutputSnapshot): string {
  let body = snapshot.stdout;
  if (snapshot.stderr.length > 0) {
    if (body.length > 0 && !body.endsWith("\n")) {
      body += "\n";
    }
    body += `[stderr]\n${snapshot.stderr}`;
  }
  if (body.length === 0) {
    body = "(no output)";
  }
  if (snapshot.truncated) {
    body += `\n\n${truncationNotice(snapshot)}`;
  }
  return body;
}

function truncationNotice(snapshot: ShellOutputSnapshot): string {
  if (snapshot.spillFailed === true || snapshot.spillPath === undefined) {
    return "[output truncated]";
  }
  return snapshot.spillTruncated === true
    ? `[output truncated; the full output exceeded the spill cap, first part saved to: ${snapshot.spillPath}]`
    : `[output truncated; full output: ${snapshot.spillPath}]`;
}

/**
 * How the run ended, in the order a reader needs it: the interruption, then the
 * termination cause. A timeout kill also reports its signal; a plain non-zero
 * exit reports its code.
 */
function shellStatusMarkers(metadata: ShellToolMetadata | undefined): string[] {
  // 后台调用没有退出码：它的结局写在任务的状态行里，由 job-output 交回。
  if (metadata?.kind !== "foreground") {
    return [];
  }
  const markers: string[] = [];
  if (metadata.timeout) {
    markers.push(`[timed out after ${metadata.timeoutMs}ms]`);
  }
  if (metadata.aborted) {
    markers.push("[aborted]");
  }
  if (metadata.signal !== null) {
    markers.push(`[killed by signal: ${metadata.signal}]`);
  } else if (metadata.exitCode !== null && metadata.exitCode !== 0) {
    markers.push(`[exit code: ${metadata.exitCode}]`);
  }
  return markers;
}
