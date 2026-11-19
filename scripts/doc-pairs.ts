/** Every defect that the rule can report. */
export type Reason =
  | "copy without a document"
  | "has a copy; delete the manifest entry"
  | "manifest entry has no document"
  | "manifest entry is a copy"
  | "missing copy";

/** A defect in one document or in one copy. */
export type Problem = {
  /** The path to look at, relative to the repository root. */
  file: string;
  /** What is wrong, in one clause. */
  reason: Reason;
};

/** Documents end with this suffix. */
const DOCUMENT_SUFFIX = ".md";

/** A copy adds this suffix: `plan.md` has `plan.zh.md`. */
const COPY_SUFFIX = ".zh.md";

/** Paths that hold texts from another repository, or a copy of this one. */
const EXCLUDED_PREFIXES = [
  ".agents/skills/",
  ".agents/worktrees/",
  ".claude/worktrees/",
];

/** Symbolic links to `AGENTS.md`. A link is not a source. */
const EXCLUDED_FILES = new Set([
  ".github/copilot-instructions.md",
  "CLAUDE.md",
]);

const isExcluded = (file: string) =>
  EXCLUDED_FILES.has(file) ||
  EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix));

const isCopy = (file: string) => file.endsWith(COPY_SUFFIX);

/** The document that `docs/plan.zh.md` copies. */
const sourceOf = (copy: string) =>
  `${copy.slice(0, -COPY_SUFFIX.length)}${DOCUMENT_SUFFIX}`;

/** The copy that `docs/plan.md` needs. */
const copyOf = (document: string) =>
  `${document.slice(0, -DOCUMENT_SUFFIX.length)}${COPY_SUFFIX}`;

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** The documents that are still Chinese. */
export const readManifest = (text: string): string[] => {
  const parsed: unknown = JSON.parse(text);
  const documents =
    typeof parsed === "object" && parsed !== null && "documents" in parsed
      ? parsed.documents
      : undefined;

  if (!isStringList(documents)) {
    throw new Error("the manifest needs a documents list of paths");
  }

  return documents;
};

/**
 * Reports every document that breaks the rule in `docs/agents/language.md`.
 *
 * A document that is not in the manifest needs a copy. A document in the manifest may
 * stay Chinese until someone translates it. A copy needs its document.
 */
export const findProblems = (input: {
  /** Every Markdown file in the repository. */
  files: string[];
  /** The documents that are still Chinese. */
  manifest: string[];
}): Problem[] => {
  const files = new Set(input.files.filter((file) => !isExcluded(file)));
  const manifest = new Set(input.manifest);
  const problems: Problem[] = [];

  for (const file of [...files].toSorted()) {
    if (isCopy(file)) {
      if (!files.has(sourceOf(file))) {
        problems.push({ file, reason: "copy without a document" });
      }
      continue;
    }

    if (manifest.has(file) || files.has(copyOf(file))) {
      continue;
    }

    problems.push({ file, reason: "missing copy" });
  }

  for (const file of input.manifest) {
    if (!files.has(file)) {
      problems.push({ file, reason: "manifest entry has no document" });
      continue;
    }

    if (isCopy(file)) {
      problems.push({ file, reason: "manifest entry is a copy" });
      continue;
    }

    if (files.has(copyOf(file))) {
      problems.push({ file, reason: "has a copy; delete the manifest entry" });
    }
  }

  return problems;
};
