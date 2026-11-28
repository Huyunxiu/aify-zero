/**
 * Reject a Chinese comment on a line a commit adds.
 *
 * Usage: `tsx scripts/check-comment-language.ts [file ...]`. `vp staged` passes the staged
 * paths; with no arguments the script asks Git for every staged file. The rule and the
 * reading live in `comment-language.ts`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { addedLines, commentViolations } from "./comment-language.js";

const SOURCE_FILE = /\.(?:ts|tsx)$/u;

/** The staged content of `path`, or the file on disk when Git has no copy. */
function contentOf(path: string): string {
  try {
    return execFileSync("git", ["show", `:${path}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return readFileSync(path, "utf-8");
  }
}

function stagedPaths(): string[] {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACM"],
    { encoding: "utf-8" }
  );
  return output.split("\n").filter((path) => path.length > 0);
}

const candidates = (
  process.argv.length > 2 ? process.argv.slice(2) : stagedPaths()
).filter((path) => SOURCE_FILE.test(path));

if (candidates.length > 0) {
  const diff = execFileSync(
    "git",
    ["diff", "--cached", "-U0", "--no-color", "--", ...candidates],
    { encoding: "utf-8" }
  );

  let failures = 0;
  for (const [path, lines] of addedLines(diff)) {
    for (const violation of commentViolations(contentOf(path), lines)) {
      console.error(
        `${path}:${violation.line} ${violation.text}\n` +
          "A new or changed comment must be English. See docs/agents/language.md."
      );
      failures += 1;
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}
