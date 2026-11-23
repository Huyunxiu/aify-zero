import { getErrorMessage } from "@workspace/shared/errors";
import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { ToolEnvironment } from "../extensions/capabilities";
import { shellQuote, toolPathDescription } from "../utils/fs-util";
import { getRipgrepAvailable, getRipgrepPath } from "../utils/ripgrep";
import { truncateContent } from "../utils/truncate";
import type { ToolOutput } from "./types";

/** Maximum total output bytes before truncation (50 KB, matching read-file). */
const MAX_BYTES = 50 * 1024;

/** Maximum characters per line before truncation. */
const MAX_LINE_LENGTH = 2000;

/** Suffix appended to lines exceeding {@link MAX_LINE_LENGTH}. */
const LINE_TRUNCATION_SUFFIX = " [truncated]";

/** Default number of matches per file. */
const DEFAULT_LIMIT = 100;

/** Maximum allowed matches per file. */
const MAX_LIMIT = 1000;

const GREP_TOOL_INPUT_SCHEMA = z.object({
  context: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe(
      "Number of surrounding context lines to include before and after each match. Defaults to 0."
    ),
  glob: z
    .string()
    .optional()
    .describe('Filter files by glob pattern (e.g. "*.ts", "*.{ts,tsx}").'),
  ignoreCase: z
    .boolean()
    .optional()
    .default(false)
    .describe("Perform case-insensitive search. Defaults to false."),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .default(DEFAULT_LIMIT)
    .describe(
      `Maximum number of matching lines to return in total. Defaults to ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`
    ),
  literal: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Treat the pattern as a literal string instead of a regular expression. Defaults to false."
    ),
  path: z
    .string()
    .optional()
    .describe(
      `${toolPathDescription("directory or file to search in")} Defaults to the working directory.`
    ),
  pattern: z
    .string()
    .min(1)
    .describe(
      'The regex pattern to search for in file contents (e.g. "log.*Error", "function\\s+\\w+").'
    ),
});

type GrepToolInput = z.infer<typeof GREP_TOOL_INPUT_SCHEMA>;

type GrepToolOutputMetadata = {
  matchCount: number;
  path: string;
  truncatedByBytes: boolean;
  truncatedByLines: boolean;
  exitCode: number | null;
};

type GrepToolOutput = ToolOutput<string, GrepToolOutputMetadata>;

const DESCRIPTION = [
  "Fast content search tool that works with any workspace size.",
  "",
  "Usage:",
  '- Searches file contents using regular expressions (e.g. "log.*Error", "function\\\\s+\\\\w+").',
  '- Filter files by pattern with the glob parameter (e.g. "*.js", "*.{ts,tsx}").',
  "- Returns matching lines with file paths and line numbers.",
  "- Use this tool when you need to find files containing specific patterns.",
  "- Call this tool in parallel when you have multiple independent searches.",
  "- Files ignored by .gitignore and .ignore files are not searched.",
  `- Each line is truncated to ${MAX_LINE_LENGTH} characters if needed.`,
  `- Output is capped at ${MAX_BYTES / 1024} KB total.`,
  `- Returns at most ${DEFAULT_LIMIT} matching lines in total (max ${MAX_LIMIT}), across all files.`,
  "- A search with no match is a normal result, not an error.",
].join("\n");

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

interface BuildCommandInput {
  readonly contextLines: number;
  readonly effectiveLimit: number;
  readonly glob: string | undefined;
  readonly ignoreCase: boolean;
  readonly literal: boolean;
  readonly normalizedPath: string;
  readonly pattern: string;
}

/**
 * Builds the grep command. It is the only form: ripgrep respects
 * `.gitignore` out of the box and handles hidden files the same way on every
 * host. A `grep -rn` fallback used to search other files, so one call could
 * return two different answers.
 *
 * `--no-messages` is intentionally *not* passed — we want ripgrep's
 * error messages to flow through stderr so callers can distinguish a
 * real failure (missing binary, unreadable path) from a legitimate
 * empty result.
 */
function buildRipgrepCommand(input: BuildCommandInput): string {
  const parts: string[] = [
    shellQuote(getRipgrepPath()),
    "--line-number",
    "--color=never",
    "--hidden",
    "--glob '!.git/*'",
  ];

  if (input.ignoreCase) {
    parts.push("--ignore-case");
  }

  if (input.literal) {
    parts.push("--fixed-strings");
  }

  if (input.glob !== undefined) {
    parts.push(`--glob ${shellQuote(input.glob)}`);
  }

  if (input.contextLines > 0) {
    parts.push(`--context ${input.contextLines}`);
  }

  // `--max-count` limits matches per file; we use it to bound total output.
  parts.push(`--max-count ${input.effectiveLimit}`);
  parts.push("--");
  parts.push(shellQuote(input.pattern));
  parts.push(shellQuote(input.normalizedPath));

  return parts.join(" ");
}

type CreateGrepToolProps = {
  agentContext: ToolEnvironment;
  /** Whether ripgrep can run. A test passes its own answer. */
  ripgrepAvailable?: () => Promise<boolean>;
};

/**
 * 没有匹配结果时的元数据。
 *
 * 失败、取消、没匹配到都还没有匹配数：四处返回同一个形状，改一处就够。
 */
const emptyMetadata = (path: string, exitCode: number | null) => ({
  matchCount: 0,
  path,
  truncatedByBytes: false,
  truncatedByLines: false,
  exitCode,
});

const createGrepTool = ({
  agentContext,
  ripgrepAvailable = getRipgrepAvailable,
}: CreateGrepToolProps) =>
  tool<GrepToolInput, GrepToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: GREP_TOOL_INPUT_SCHEMA,
    execute: async (input, { abortSignal }) => {
      const { sandbox } = agentContext;
      const normalizedPath = sandbox.resolvePath(input.path ?? ".");
      const effectiveLimit = Math.min(
        Math.max(1, input.limit ?? DEFAULT_LIMIT),
        MAX_LIMIT
      );
      const contextLines = input.context ?? 0;

      // One behaviour: without ripgrep the search cannot run the way the
      // description says, so it says so instead of searching other files.
      if (!(await ripgrepAvailable())) {
        return {
          output:
            "Grep needs ripgrep, which cannot run here. Nothing was searched.",
          code: "error",
          metadata: emptyMetadata(normalizedPath, null),
        };
      }

      const command = buildRipgrepCommand({
        contextLines,
        effectiveLimit,
        glob: input.glob,
        ignoreCase: input.ignoreCase ?? false,
        literal: input.literal ?? false,
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
          output: `Grep failed: ${getErrorMessage(error)}`,
          code: "error",
          metadata: emptyMetadata(normalizedPath, null),
        };
      }

      if (run.aborted) {
        return {
          output: "Grep search was aborted.",
          code: "error",
          metadata: emptyMetadata(normalizedPath, run.exitCode),
        };
      }

      // Exit codes: 0 = matches found, 1 = no matches, 2+ = error.
      if (run.exitCode !== null && run.exitCode > 1) {
        const trimmedStderr = stderr.trim();
        const detail =
          trimmedStderr.length > 0 ? trimmedStderr : "unknown error";
        return {
          output: `Grep failed (exit ${run.exitCode}): ${detail}`,
          code: "error",
          metadata: emptyMetadata(normalizedPath, run.exitCode),
        };
      }

      if (stdout.trim().length === 0) {
        return {
          output: "No matches found.",
          code: "ok",
          metadata: emptyMetadata(normalizedPath, run.exitCode),
        };
      }

      const truncated = truncateContent({
        content: stdout,
        maxBytes: MAX_BYTES,
        maxLines: effectiveLimit,
        maxLineLength: MAX_LINE_LENGTH,
        lineTruncationSuffix: LINE_TRUNCATION_SUFFIX,
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
          matchCount: truncated.outputLines,
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

type GrepToolType = ReturnType<typeof createGrepTool>;

export { createGrepTool, type GrepToolType };
