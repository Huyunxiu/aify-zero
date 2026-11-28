/**
 * The rule that a new or changed comment is English, as code.
 *
 * A change adds lines; some of them are comments. This reads those lines out of a unified
 * diff and reports the ones that carry Chinese. Lines the change does not touch are never
 * read, so the Chinese comments already in a file stay Chinese until someone changes that
 * part — which is what `docs/agents/language.md` says.
 */

const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF]/u;

/**
 * The line numbers a unified diff adds, per file, counting from 1.
 *
 * @param diff - output of `git diff -U0`.
 */
export function addedLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let path: string | undefined;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      path = line.slice(4).replace(/^b\//u, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!hunk || path === undefined) {
      continue;
    }
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) {
      continue;
    }
    const lines = files.get(path) ?? new Set<number>();
    for (let offset = 0; offset < count; offset += 1) {
      lines.add(start + offset);
    }
    files.set(path, lines);
  }

  return files;
}

/** A quoted string replaced by its quotes, so text inside it cannot read as a comment. */
function withoutStrings(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replace(/'(?:[^'\\]|\\.)*'/gu, "''")
    .replace(/`(?:[^`\\]|\\.)*`/gu, "``");
}

/**
 * The comment text on `line`, or `undefined` when the line has no comment.
 *
 * `inBlock` carries an open block comment from one line to the next. Only the first
 * comment on a line counts.
 */
function commentOn(
  line: string,
  inBlock: { open: boolean }
): string | undefined {
  const visible = withoutStrings(line);

  if (inBlock.open) {
    if (visible.includes("*/")) {
      inBlock.open = false;
    }
    return visible;
  }

  const lineComment = visible.indexOf("//");
  const blockComment = visible.indexOf("/*");
  if (lineComment === -1 && blockComment === -1) {
    return undefined;
  }
  if (
    blockComment !== -1 &&
    (lineComment === -1 || blockComment < lineComment)
  ) {
    inBlock.open = !visible.slice(blockComment + 2).includes("*/");
    return visible.slice(blockComment);
  }
  return visible.slice(lineComment);
}

/**
 * Comments that break the rule, for the given added line numbers.
 *
 * @param source - the whole file, because a block comment spans lines.
 * @param lines - the lines the change adds, counting from 1.
 */
export function commentViolations(
  source: string,
  lines: Iterable<number>
): { line: number; text: string }[] {
  const wanted = new Set(lines);
  const inBlock = { open: false };
  const violations: { line: number; text: string }[] = [];

  const lines_ = source.split("\n");
  for (let index = 0; index < lines_.length; index += 1) {
    const lineNumber = index + 1;
    const comment = commentOn(lines_[index] ?? "", inBlock);
    if (comment !== undefined && wanted.has(lineNumber) && HAN.test(comment)) {
      violations.push({ line: lineNumber, text: comment.trim() });
    }
  }

  return violations;
}
