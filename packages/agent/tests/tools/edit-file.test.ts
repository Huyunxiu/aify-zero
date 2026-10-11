import { describe, expect, test } from "vitest";

import { countLineDelta } from "../../src/tools/edit-file.js";

describe(countLineDelta, () => {
  test("should count a single line change as one line either way", () => {
    expect(countLineDelta("const a = 1;", "const a = 2;", 1)).toStrictEqual({
      linesAdded: 1,
      linesRemoved: 1,
    });
  });

  test("should trim the lines the two strings share", () => {
    // One word changes on the middle line of five; the four untouched lines
    // must not be reported as changed.
    expect(countLineDelta("a\nb\nc\nd\ne", "a\nb\nX\nd\ne", 1)).toStrictEqual({
      linesAdded: 1,
      linesRemoved: 1,
    });
  });

  test("should overcount rather than undercount when a change sits between shared lines", () => {
    // The prefix and suffix both stop here, so the two shared lines between the
    // changes are counted on both sides. Documented behaviour, not a bug.
    expect(countLineDelta("a\nb\nc\nd\ne", "a\nX\nc\nY\ne", 1)).toStrictEqual({
      linesAdded: 3,
      linesRemoved: 3,
    });
  });

  test("should count pure additions and pure removals", () => {
    expect(countLineDelta("", "a\nb", 1)).toStrictEqual({
      linesAdded: 2,
      linesRemoved: 0,
    });
    expect(countLineDelta("a\nb", "", 1)).toStrictEqual({
      linesAdded: 0,
      linesRemoved: 2,
    });
  });

  test("should multiply the delta by the number of replace-all occurrences", () => {
    expect(countLineDelta("const a = 1;", "const a = 2;", 3)).toStrictEqual({
      linesAdded: 3,
      linesRemoved: 3,
    });
  });
});
