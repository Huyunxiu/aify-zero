import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { findProblems, readManifest } from "./doc-pairs.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const MANIFEST = path.join(ROOT, "scripts/doc-pairs.manifest.json");

/**
 * Every Markdown file that git tracks, plus the new ones that git does not ignore.
 *
 * A file that git tracks but the disk does not have is dropped: the check reads the
 * files, not the index.
 */
const listMarkdown = (): string[] =>
  execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"],
    { cwd: ROOT, encoding: "utf-8" }
  )
    .split("\n")
    .filter((file) => file.length > 0 && existsSync(path.join(ROOT, file)));

const problems = findProblems({
  files: listMarkdown(),
  manifest: readManifest(readFileSync(MANIFEST, "utf-8")),
});

if (problems.length === 0) {
  console.log("[docs] every document has its copy");
} else {
  for (const problem of problems) {
    console.error(`[docs] ${problem.file}: ${problem.reason}`);
  }
  process.exitCode = 1;
}
