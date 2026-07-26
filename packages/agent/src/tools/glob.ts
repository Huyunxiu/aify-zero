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
      "The directory to search in. Defaults to the working directory. Must be an absolute path."
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
  "- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.",
  "- Use the grep tool instead if you need to search file contents.",
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
 * Builds the ripgrep form of the glob command. Preferred whenever
 * `rg` is on PATH.
 *
 * Truncation is enforced in JavaScript rather than via a shell `| head`
 * pipe: piping would mask ripgrep's exit code (the pipeline would adopt
 * `head`'s exit code, which is typically 0), making a missing `rg`
 * binary or a real IO failure indistinguishable from a successful
 * search with no results.
 */
function buildRipgrepCommand(input: BuildCommandInput): string {
  return [
    "rg --files --hidden",
    "--glob '!.git/*'",
    `--glob ${shellQuote(input.pattern)}`,
    `-- ${shellQuote(input.normalizedPath)}`,
  ].join(" ");
}

// POSIX fallback used when ripgrep is unavailable. Globstars collapse
// to GNU find's slash-spanning `*`; brace expansion is not supported.
function buildPosixFindCommand(input: BuildCommandInput): string {
  const translatedPattern = translateGlobToFindPattern(input.pattern);

  // If the translated pattern has no slash after translation, it is
  // a basename-only pattern — match against `-name` which is faster
  // and semantically cleaner than `-path`. Otherwise match against
  // the full path with `-path` (note: `-path` requires the full path
  // prefix to match, so we include `*/` to anchor anywhere in the
  // tree).
  const isBasenameOnly = !translatedPattern.includes("/");
  const matchExpression = isBasenameOnly
    ? `-name ${shellQuote(translatedPattern)}`
    : `-path ${shellQuote(`*/${translatedPattern}`)}`;

  return [
    `find ${shellQuote(input.normalizedPath)}`,
    "-type f",
    "-not -path '*/.git/*'",
    matchExpression,
  ].join(" ");
}

// Translates a ripgrep-style glob pattern to a POSIX `find`-compatible
// pattern.
//
//   - A globstar (two `*` in a row) matches any number of directory
//     segments. POSIX `find`'s single `*` also crosses `/` boundaries
//     (unlike bash globs), so a globstar collapses to one `*`.
//   - A leading globstar-slash prefix is equivalent to "at any
//     depth". When the rest of the pattern has no directory
//     component we return just the basename, letting the caller use
//     `-name` for efficiency.
function translateGlobToFindPattern(pattern: string): string {
  // Collapse `**` to `*` since find's `*` already crosses `/`.
  let translated = pattern.replaceAll("**", "*");

  // Strip a leading `*/` so a globstar-prefixed pattern like
  // `**/*.ts` becomes `*.ts` (basename match).
  while (translated.startsWith("*/")) {
    translated = translated.slice(2);
  }

  return translated;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

type CreateGlobToolProps = {
  agentContext: AgentContext;
};

const createGlobTool = ({ agentContext }: CreateGlobToolProps) =>
  tool<GlobToolInput, GlobToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: GLOB_TOOL_INPUT_SCHEMA,
    execute: async (input, { abortSignal }) => {
      const effectivePath = input.path ?? agentContext.workdir;

      if (!isAbsolute(effectivePath)) {
        return {
          output: `Path must be an absolute path. Received: "${effectivePath}". Use an absolute path such as ${agentContext.workdir}/src.`,
          code: "error",
          metadata: {
            count: 0,
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

      const useRipgrep = await getRipgrepAvailable();
      const command = useRipgrep
        ? buildRipgrepCommand({ normalizedPath, pattern: input.pattern })
        : buildPosixFindCommand({ normalizedPath, pattern: input.pattern });

      return await new Promise<GlobToolOutput>((resolve) => {
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
            output: `Glob failed: ${getErrorMessage(err)}`,
            code: "error",
            metadata: {
              count: 0,
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
              output: "Glob search was aborted.",
              code: "error",
              metadata: {
                count: 0,
                path: normalizedPath,
                truncatedByBytes: false,
                truncatedByLines: false,
                exitCode,
              },
            });
            return;
          }

          // Exit codes: 0 = matches found, 1 = rg-specific no matches, 2+ = error.
          if (exitCode !== null && exitCode > 1) {
            const trimmedStderr = stderr.trim();
            const detail =
              trimmedStderr.length > 0 ? trimmedStderr : "unknown error";
            resolve({
              title,
              output: `Glob failed (exit ${exitCode}): ${detail}`,
              code: "error",
              metadata: {
                count: 0,
                path: normalizedPath,
                truncatedByBytes: false,
                truncatedByLines: false,
                exitCode,
              },
            });
            return;
          }

          const rawLines = stdout.split("\n").filter((line) => line.length > 0);

          // Normalize each path.
          const paths: string[] = [];
          for (const line of rawLines) {
            paths.push(normalizePath(line));
          }

          if (paths.length === 0) {
            resolve({
              title,
              output: "No files found.",
              code: "ok",
              metadata: {
                count: 0,
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
              count: truncated.outputLines,
              path: normalizedPath,
              truncatedByBytes: truncated.truncatedByBytes,
              truncatedByLines: truncated.truncatedByLines,
              exitCode,
            },
            // title,
            // output: truncated.lines.join("\n"),
            // code: "ok",
            // metadata: {
            //   count: boundedPaths.length,
            //   path: normalizedPath,
            //   truncated: truncatedByCount || truncated.truncatedByBytes,
            //   exitCode,
            // },
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

type GlobToolType = InferUITool<ReturnType<typeof createGlobTool>>;

export { createGlobTool, type GlobToolType };
