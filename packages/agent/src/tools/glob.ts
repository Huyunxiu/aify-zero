import { getErrorMessage } from "@workspace/shared/errors";
import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { ToolEnvironment } from "../extensions/capabilities";
import {
  normalizePath,
  shellQuote,
  toolPathDescription,
} from "../utils/fs-util";
import { getRipgrepAvailable, getRipgrepPath } from "../utils/ripgrep";
import { truncateContent } from "../utils/truncate";
import type { ToolOutput } from "./types";

/** Maximum total output bytes before truncation (50 KB, matching read-file). */
const MAX_BYTES = 50 * 1024;

/** Default number of results. */
const DEFAULT_LIMIT = 100;

/** Maximum allowed results. */
const MAX_LIMIT = 1000;

const GLOB_TOOL_INPUT_SCHEMA = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .default(DEFAULT_LIMIT)
    .describe(
      `Maximum number of results to return. Defaults to ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`
    ),
  path: z
    .string()
    .optional()
    .describe(
      `${toolPathDescription("directory to search in")} Defaults to the working directory.`
    ),
  pattern: z
    .string()
    .min(1)
    .describe(
      'The glob pattern to match files against (e.g. "**/*.ts", "src/**/*.js").'
    ),
});

type GlobToolInput = z.infer<typeof GLOB_TOOL_INPUT_SCHEMA>;

type GlobToolOutputMetadata = {
  count: number;
  path: string;
  truncatedByBytes: boolean;
  truncatedByLines: boolean;
  exitCode: number | null;
};

type GlobToolOutput = ToolOutput<string, GlobToolOutputMetadata>;

const DESCRIPTION = [
  "Fast file pattern matching tool that works with any codebase size.",
  "",
  "Usage:",
  '- Supports glob patterns like "**/*.js" or "src/**/*.ts".',
  "- Returns matching file paths.",
  "- Use this tool when you need to find files by name patterns.",
  "- Files ignored by .gitignore and .ignore files are not searched.",
  "- A search with no match is a normal result, not an error.",
  "- Call this tool in parallel when you know there are multiple patterns to search for.",
].join("\n");

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

interface BuildCommandInput {
  readonly normalizedPath: string;
  readonly pattern: string;
}

/**
 * Builds the glob command. It is the only form: a POSIX fallback used to
 * search with different ignore rules, so the same call could return two
 * different answers.
 *
 * Truncation is enforced in JavaScript rather than via a shell `| head`
 * pipe: piping would mask ripgrep's exit code (the pipeline would adopt
 * `head`'s exit code, which is typically 0), making a missing `rg`
 * binary or a real IO failure indistinguishable from a successful
 * search with no results.
 */
function buildRipgrepCommand(input: BuildCommandInput): string {
  return [
    `${shellQuote(getRipgrepPath())} --files --hidden`,
    "--glob '!.git/*'",
    `--glob ${shellQuote(input.pattern)}`,
    `-- ${shellQuote(input.normalizedPath)}`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

type CreateGlobToolProps = {
  agentContext: ToolEnvironment;
  /** Whether ripgrep can run. A test passes its own answer. */
  ripgrepAvailable?: () => Promise<boolean>;
};

/** 没有结果时的元数据；失败、取消、没找到都走这一个形状。 */
const emptyMetadata = (path: string, exitCode: number | null) => ({
  count: 0,
  path,
  truncatedByBytes: false,
  truncatedByLines: false,
  exitCode,
});

const createGlobTool = ({
  agentContext,
  ripgrepAvailable = getRipgrepAvailable,
}: CreateGlobToolProps) =>
  tool<GlobToolInput, GlobToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: GLOB_TOOL_INPUT_SCHEMA,
    execute: async (input, { abortSignal }) => {
      const { sandbox } = agentContext;
      const normalizedPath = sandbox.resolvePath(input.path ?? ".");
      const effectiveLimit = Math.min(
        Math.max(1, input.limit ?? DEFAULT_LIMIT),
        MAX_LIMIT
      );

      // One behaviour: without ripgrep the search cannot run the way the
      // description says, so it says so instead of searching other files.
      if (!(await ripgrepAvailable())) {
        return {
          output:
            "Glob needs ripgrep, which cannot run here. Nothing was searched.",
          code: "error",
          metadata: emptyMetadata(normalizedPath, null),
        };
      }

      const command = buildRipgrepCommand({
        normalizedPath,
        pattern: input.pattern,
      });

      let stdout = "";
      let stderr = "";
      let run;
      try {
        run = await sandbox.exec(command, {
          cwd: sandbox.resolvePath("."),
          signal: abortSignal,
          onData: (channel, chunk) => {
            if (channel === "stdout") {
              stdout += chunk.toString();
            } else {
              stderr += chunk.toString();
            }
          },
        });
      } catch (error) {
        return {
          output: `Glob failed: ${getErrorMessage(error)}`,
          code: "error",
          metadata: emptyMetadata(normalizedPath, null),
        };
      }

      if (run.aborted) {
        return {
          output: "Glob search was aborted.",
          code: "error",
          metadata: emptyMetadata(normalizedPath, run.exitCode),
        };
      }

      // Exit codes: 0 = matches found, 1 = rg-specific no matches, 2+ = error.
      if (run.exitCode !== null && run.exitCode > 1) {
        const trimmedStderr = stderr.trim();
        const detail =
          trimmedStderr.length > 0 ? trimmedStderr : "unknown error";
        return {
          output: `Glob failed (exit ${run.exitCode}): ${detail}`,
          code: "error",
          metadata: emptyMetadata(normalizedPath, run.exitCode),
        };
      }

      const paths = stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => normalizePath(line));

      if (paths.length === 0) {
        return {
          output: "No files found.",
          code: "ok",
          metadata: emptyMetadata(normalizedPath, run.exitCode),
        };
      }

      const truncated = truncateContent({
        content: stdout,
        maxBytes: MAX_BYTES,
        maxLines: effectiveLimit,
      });

      const notices: string[] = [];
      if (truncated.truncatedByLines) {
        notices.push(
          `Match limit reached (${effectiveLimit}). Use a larger limit or more specific pattern.`
        );
      }
      if (truncated.truncatedByBytes) {
        notices.push(
          "Output truncated due to size. Use a more specific path or pattern."
        );
      }

      const content =
        notices.length > 0
          ? truncated.lines.join("\n") + `\n\n[${notices.join(" ")}]`
          : truncated.lines.join("\n");

      return {
        output: content,
        code: "ok",
        metadata: {
          count: truncated.outputLines,
          path: normalizedPath,
          truncatedByBytes: truncated.truncatedByBytes,
          truncatedByLines: truncated.truncatedByLines,
          exitCode: run.exitCode,
        },
      };
    },
    toModelOutput({ output }) {
      if (output.code === "error") {
        return { type: "error-text", value: output.output };
      }
      return { type: "text", value: output.output };
    },
  });

type GlobToolType = ReturnType<typeof createGlobTool>;

export { createGlobTool, type GlobToolType };
