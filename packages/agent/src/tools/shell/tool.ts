import { stat } from "node:fs/promises";

import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../../agent-context";
import { resolveToolPath } from "../../utils/fs-util";
import type { ToolOutput } from "../types";
import { runShell } from "./exec";
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
  /** Resolved lazily so a missing executable reports on the call, not on load. */
  program: () => ShellProgram;
}

export type ShellToolMetadata = {
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

export type ShellToolOutput = ToolOutput<string, ShellToolMetadata>;

type ShellToolInput = {
  command: string;
  timeout?: number;
  workdir?: string;
  description: string;
};

const createShellToolSchema = (agentContext: AgentContext) =>
  z.object({
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
  program,
}: ShellToolOptions): Tool<ShellToolInput, ShellToolOutput, AgentContext> =>
  tool<ShellToolInput, ShellToolOutput, AgentContext>({
    description,
    inputSchema: createShellToolSchema(agentContext),
    execute: async ({ command, timeout, workdir }, { abortSignal }) => {
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
  if (metadata === undefined) {
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
