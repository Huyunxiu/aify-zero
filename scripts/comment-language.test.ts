import { describe, expect, test } from "vitest";

import { addedLines, commentViolations } from "./comment-language";

describe("added lines", () => {
  test("reads one hunk per file", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3,0 +4,2 @@",
      "+// one",
      "+const x = 1;",
      "@@ -10,0 +12,1 @@",
      "+// two",
    ].join("\n");

    expect([...(addedLines(diff).get("a.ts") ?? [])]).toStrictEqual([4, 5, 12]);
  });

  test("reads a file that did not exist before", () => {
    const diff = [
      "diff --git a/b.ts b/b.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.ts",
      "@@ -0,0 +1,3 @@",
      "+one",
      "+two",
      "+three",
    ].join("\n");

    expect([...(addedLines(diff).get("b.ts") ?? [])]).toStrictEqual([1, 2, 3]);
  });

  test("says nothing about a file with no added line", () => {
    const diff = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,0 +1,0 @@"].join("\n");

    expect(addedLines(diff).size).toBe(0);
  });
});

describe("comment violations", () => {
  // The array order is the line number: line 1 is the first entry.
  const source = [
    "const url = 'http://example.test';",
    "// new comment in Chinese",
    "const name = 'plain';",
    "/*",
    " * block comment",
    " */",
    "const after = 1; // trailing",
    "// english comment",
  ].join("\n");

  test("reports a Chinese comment on an added line", () => {
    const withHan = source.replace(
      "// new comment in Chinese",
      "// \u65B0\u6CE8\u91CA"
    );

    expect(commentViolations(withHan, [2])).toStrictEqual([
      { line: 2, text: "// \u65B0\u6CE8\u91CA" },
    ]);
  });

  test("reports Chinese inside a block comment", () => {
    const withHan = source.replace(" * block comment", " * \u5757\u6CE8\u91CA");

    expect(commentViolations(withHan, [5])).toStrictEqual([
      { line: 5, text: "* \u5757\u6CE8\u91CA" },
    ]);
  });

  test("reports Chinese in a comment after code on the same line", () => {
    const withHan = source.replace("// trailing", "// \u884C\u5C3E");

    expect(commentViolations(withHan, [7])).toStrictEqual([
      { line: 7, text: "// \u884C\u5C3E" },
    ]);
  });

  test("ignores Chinese in strings", () => {
    const withHan = source
      .replace("'http://example.test'", "'http://\u4F8B\u5B50.test'")
      .replace("'plain'", "'\u4E2D\u6587'");

    expect(commentViolations(withHan, [1, 3])).toStrictEqual([]);
  });

  test("ignores a Chinese comment the change did not touch", () => {
    const withHan = source.replace(
      "// english comment",
      "// \u4E2D\u6587\u6CE8\u91CA"
    );

    expect(commentViolations(withHan, [1, 3])).toStrictEqual([]);
  });

  test("ignores an English comment", () => {
    expect(commentViolations("// a comment", [1])).toStrictEqual([]);
  });
});
