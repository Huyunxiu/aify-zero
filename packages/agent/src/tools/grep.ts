import { spawn } from "node:child_process";
import { isAbsolute, relative } from "node:path";

import { tool } from "ai";
import type { InferUITool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../context";
import { getErrorMessage } from "../utils/error";
import { normalizePath, shellQuote } from "../utils/fs-util";
import { getRipgrepAvailable } from "../utils/ripgrep";
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
      `Maximum number of matches to return per file. Defaults to ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`
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
      "The directory or file to search in. Defaults to the working directory. Must be an absolute path."
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
  `- Each line is truncated to ${MAX_LINE_LENGTH} characters if needed.`,
  `- Output is capped at ${MAX_BYTES / 1024} KB total.`,
  `- Default limit is ${DEFAULT_LIMIT} matches per file (max ${MAX_LIMIT}).`,
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
 * Builds the ripgrep form of the grep command. Preferred whenever
 * `rg` is on PATH — ripgrep respects `.gitignore` out of the box,
 * handles hidden-file semantics cleanly, and is substantially faster
 * than GNU grep on large repositories.
 *
 * `--no-messages` is intentionally *not* passed — we want ripgrep's
 * error messages to flow through stderr so callers can distinguish a
 * real failure (missing binary, unreadable path) from a legitimate
 * empty result.
 */
function buildRipgrepCommand(input: BuildCommandInput): string {
  const parts: string[] = [
    "rg",
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

  console.log(123, parts.join(" "));

  return parts.join(" ");
}

/**
 * Builds the POSIX fallback form of the grep command using `grep -rn`.
 */
function buildPosixGrepCommand(input: BuildCommandInput): string {
  const parts: string[] = [
    "grep",
    "-r",
    "-n",
    "--color=never",
    "--exclude-dir=.git",
  ];

  if (input.ignoreCase) {
    parts.push("-i");
  }

  if (input.literal) {
    parts.push("-F");
  } else {
    // Default to ERE so the pattern semantics line up with ripgrep's
    // default (which uses a Rust regex dialect close to ERE).
    parts.push("-E");
  }

  if (input.glob !== undefined) {
    parts.push(`--include=${shellQuote(input.glob)}`);
  }

  if (input.contextLines > 0) {
    parts.push(`-C ${input.contextLines}`);
  }

  // `-m` limits matches per file, analogous to ripgrep's `--max-count`.
  parts.push(`-m ${input.effectiveLimit}`);
  parts.push("--");
  parts.push(shellQuote(input.pattern));
  parts.push(shellQuote(input.normalizedPath));

  return parts.join(" ");
}

type CreateGrepToolProps = {
  agentContext: AgentContext;
};

const createGrepTool = ({ agentContext }: CreateGrepToolProps) =>
  tool<GrepToolInput, GrepToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: GREP_TOOL_INPUT_SCHEMA,
    execute: async (input, { abortSignal }) => {
      const effectivePath = input.path ?? agentContext.workdir;

      if (!isAbsolute(effectivePath)) {
        return {
          output: `Path must be an absolute path. Received: "${effectivePath}". Use an absolute path such as ${agentContext.workdir}/src.`,
          code: "error",
          metadata: {
            matchCount: 0,
            path: effectivePath,
            truncatedByBytes: false,
            truncatedByLines: false,
            exitCode: null,
          },
        };
      }

      const normalizedPath = normalizePath(effectivePath);
      const title = relative(agentContext.workdir, normalizedPath);
      const effectiveLimit = Math.min(
        Math.max(1, input.limit ?? DEFAULT_LIMIT),
        MAX_LIMIT
      );
      const contextLines = input.context ?? 0;

      const useRipgrep = await getRipgrepAvailable();
      const command = useRipgrep
        ? buildRipgrepCommand({
            contextLines,
            effectiveLimit,
            glob: input.glob,
            ignoreCase: input.ignoreCase ?? false,
            literal: input.literal ?? false,
            normalizedPath,
            pattern: input.pattern,
          })
        : buildPosixGrepCommand({
            contextLines,
            effectiveLimit,
            glob: input.glob,
            ignoreCase: input.ignoreCase ?? false,
            literal: input.literal ?? false,
            normalizedPath,
            pattern: input.pattern,
          });

      return await new Promise<GrepToolOutput>((resolve) => {
        const proc = spawn(command, {
          shell: true,
          cwd: agentContext.workdir,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let aborted = false;

        proc.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        // Handle pre-aborted signal.
        if (abortSignal?.aborted) {
          aborted = true;
          proc.kill();
        }

        const abortHandler = () => {
          aborted = true;
          proc.kill();
        };

        abortSignal?.addEventListener("abort", abortHandler, { once: true });

        proc.on("error", (err) => {
          abortSignal?.removeEventListener("abort", abortHandler);
          resolve({
            output: `Grep failed: ${getErrorMessage(err)}`,
            code: "error",
            metadata: {
              matchCount: 0,
              path: normalizedPath,
              truncatedByBytes: false,
              truncatedByLines: false,
              exitCode: null,
            },
          });
        });

        proc.on("exit", (exitCode) => {
          abortSignal?.removeEventListener("abort", abortHandler);

          if (aborted) {
            resolve({
              output: "Grep search was aborted.",
              code: "error",
              metadata: {
                matchCount: 0,
                path: normalizedPath,
                truncatedByBytes: false,
                truncatedByLines: false,
                exitCode,
              },
            });
            return;
          }

          // Exit codes: 0 = matches found, 1 = no matches, 2+ = error.
          if (exitCode !== null && exitCode > 1) {
            const trimmedStderr = stderr.trim();
            const detail =
              trimmedStderr.length > 0 ? trimmedStderr : "unknown error";
            resolve({
              title,
              output: `Grep failed (exit ${exitCode}): ${detail}`,
              code: "error",
              metadata: {
                matchCount: 0,
                path: normalizedPath,
                truncatedByBytes: false,
                truncatedByLines: false,
                exitCode,
              },
            });
            return;
          }

          if (stdout.trim().length === 0) {
            resolve({
              title,
              output: "No matches found.",
              code: "ok",
              metadata: {
                matchCount: 0,
                path: normalizedPath,
                truncatedByBytes: false,
                truncatedByLines: false,
                exitCode,
              },
            });
            return;
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

          resolve({
            title,
            output: content,
            code: "ok",
            metadata: {
              matchCount: truncated.outputLines,
              path: normalizedPath,
              truncatedByBytes: truncated.truncatedByBytes,
              truncatedByLines: truncated.truncatedByLines,
              exitCode,
            },
          });
        });
      });
    },
    toModelOutput({ output }) {
      if (output.code === "error") {
        return { type: "error-text", value: output.output };
      }
      return { type: "text", value: output.output };
    },
  });

type GrepToolType = InferUITool<ReturnType<typeof createGrepTool>>;

export { createGrepTool, type GrepToolType };
