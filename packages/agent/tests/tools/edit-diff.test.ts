import { describe, expect, test } from "vitest";

import {
  applyEditsToNormalizedContent,
  countLineChanges,
  detectLineEnding,
  fuzzyFindText,
  generateDiffString,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  splitBom,
} from "../../src/tools/edit-diff.js";

describe(applyEditsToNormalizedContent, () => {
  test("should apply several disjoint edits in one call", () => {
    const result = applyEditsToNormalizedContent(
      "one\ntwo\nthree",
      [
        { oldText: "one", newText: "ONE" },
        { oldText: "three", newText: "THREE" },
      ],
      "file.ts"
    );

    expect(result.newContent).toBe("ONE\ntwo\nTHREE");
  });

  test("should match every edit against the original content", () => {
    // 两条编辑都基于原文件匹配：第二条匹配的是原始的 "bar"，
    // 而不是第一条刚写进去的 "bar"。
    const result = applyEditsToNormalizedContent(
      "foo bar",
      [
        { oldText: "foo", newText: "bar" },
        { oldText: "bar", newText: "baz" },
      ],
      "file.ts"
    );

    expect(result.newContent).toBe("bar baz");
  });

  test("should reject an oldText that appears more than once", () => {
    expect(() =>
      applyEditsToNormalizedContent(
        "same\nsame",
        [{ oldText: "same", newText: "other" }],
        "file.ts"
      )
    ).toThrow(/Found 2 occurrences/);
  });

  test("should reject overlapping edits", () => {
    expect(() =>
      applyEditsToNormalizedContent(
        "abcdef",
        [
          { oldText: "abcd", newText: "x" },
          { oldText: "cdef", newText: "y" },
        ],
        "file.ts"
      )
    ).toThrow(/overlap/);
  });

  test("should reject an empty oldText", () => {
    expect(() =>
      applyEditsToNormalizedContent(
        "content",
        [{ oldText: "", newText: "x" }],
        "file.ts"
      )
    ).toThrow(/must not be empty/);
  });

  test("should reject an edit that changes nothing", () => {
    expect(() =>
      applyEditsToNormalizedContent(
        "content",
        [{ oldText: "content", newText: "content" }],
        "file.ts"
      )
    ).toThrow(/No changes made/);
  });

  test("should report the original and resulting content", () => {
    const result = applyEditsToNormalizedContent(
      "before",
      [{ oldText: "before", newText: "after" }],
      "file.ts"
    );

    expect(result.baseContent).toBe("before");
    expect(result.newContent).toBe("after");
  });
});

describe("fuzzy matching", () => {
  test("should normalize trailing whitespace and smart punctuation", () => {
    const content = "const message = “hello”;   \nconst other = 1;\n";
    const result = applyEditsToNormalizedContent(
      content,
      [
        {
          oldText: 'const message = "hello";',
          newText: 'const message = "bye";',
        },
      ],
      "file.ts"
    );

    // 被改动的行从归一化文本重写；未改动的行保留原始字节。
    expect(result.newContent).toBe(
      'const message = "bye";\nconst other = 1;\n'
    );
  });

  test("should merge edits that touch the same line", () => {
    const result = applyEditsToNormalizedContent(
      "const a = 1, b = 2;",
      [
        { oldText: "a = 1", newText: "a = 10" },
        { oldText: "b = 2", newText: "b = 20" },
      ],
      "file.ts"
    );

    expect(result.newContent).toBe("const a = 10, b = 20;");
  });

  test("should prefer an exact match and fall back to fuzzy", () => {
    const exact = fuzzyFindText("hello", "hello");
    expect(exact.usedFuzzyMatch).toBeFalsy();
    expect(exact.index).toBe(0);

    const fuzzy = fuzzyFindText("say “hello”", '"hello"');
    expect(fuzzy.usedFuzzyMatch).toBeTruthy();
    expect(fuzzy.contentForReplacement).toBe(
      normalizeForFuzzyMatch('say "hello"')
    );
  });
});

describe("line endings and BOM", () => {
  test("should detect the dominant line ending", () => {
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(detectLineEnding("a\nb\n")).toBe("\n");
    expect(detectLineEnding("single line")).toBe("\n");
  });

  test("should round-trip CRLF content", () => {
    const original = "a\r\nb\r\n";
    const normalized = normalizeToLF(original);

    expect(normalized).toBe("a\nb\n");
    expect(restoreLineEndings(normalized, "\r\n")).toBe(original);
  });

  test("should split and rejoin a BOM", () => {
    const bom = String.fromCodePoint(0xfe_ff);
    const { bom: found, text } = splitBom(`${bom}content`);

    expect(found).toBe(bom);
    expect(text).toBe("content");
    expect(found + text).toBe(`${bom}content`);
    expect(splitBom("content").bom).toBe("");
  });
});

describe(countLineChanges, () => {
  test("should count a single changed line as one line either way", () => {
    expect(countLineChanges("const a = 1;", "const a = 2;")).toStrictEqual({
      linesAdded: 1,
      linesRemoved: 1,
    });
  });

  test("should count only the lines that actually changed", () => {
    expect(countLineChanges("a\nb\nc\nd\ne", "a\nb\nX\nd\ne")).toStrictEqual({
      linesAdded: 1,
      linesRemoved: 1,
    });
  });

  test("should count separate changes independently", () => {
    // 中间两条未改动的行不会被计入，这是和旧的手写估算最大的区别。
    expect(countLineChanges("a\nb\nc\nd\ne", "a\nX\nc\nY\ne")).toStrictEqual({
      linesAdded: 2,
      linesRemoved: 2,
    });
  });

  test("should count pure additions and pure removals", () => {
    expect(countLineChanges("", "a\nb")).toStrictEqual({
      linesAdded: 2,
      linesRemoved: 0,
    });
    expect(countLineChanges("a\nb", "")).toStrictEqual({
      linesAdded: 0,
      linesRemoved: 2,
    });
  });

  test("should count a multi-line replacement on both sides", () => {
    expect(countLineChanges("a\nb\nc", "a\nx\ny\nc")).toStrictEqual({
      linesAdded: 2,
      linesRemoved: 1,
    });
  });
});

describe(generateDiffString, () => {
  test("should mark removed and added lines with their line numbers", () => {
    const result = generateDiffString("one\ntwo\nthree\n", "ONE\ntwo\nTHREE\n");

    expect(result.diff).toBe("-1 one\n+1 ONE\n 2 two\n-3 three\n+3 THREE");
    expect(result.firstChangedLine).toBe(1);
  });

  test("should collapse unchanged lines far from a change", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "changed");
    const result = generateDiffString(before, after);

    // 距改动较远的上下文被省略，而不是把整份文件塞进输出。
    expect(result.diff).toContain("...");
    expect(result.diff.split("\n").length).toBeLessThan(20);
    expect(result.diff).toContain("+11 changed");
    expect(result.firstChangedLine).toBe(11);
  });

  test("should produce an empty diff when nothing changed", () => {
    expect(generateDiffString("same\n", "same\n")).toStrictEqual({
      diff: "",
      firstChangedLine: undefined,
    });
  });
});
