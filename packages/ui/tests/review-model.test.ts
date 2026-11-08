import { describe, expect, test } from "vitest";

import {
  lineCountsOf,
  reviewItemOf,
  treeInputOf,
} from "../src/elements/session-panel/review-model";

describe("review tree input", () => {
  test("gives the tree one path and one status per change", () => {
    const input = treeInputOf([
      { path: "a.ts", status: "modified" },
      { path: "b.ts", status: "untracked" },
    ]);

    expect(input.paths).toStrictEqual(["a.ts", "b.ts"]);
    expect(input.gitStatus).toStrictEqual([
      { path: "a.ts", status: "modified" },
      { path: "b.ts", status: "untracked" },
    ]);
  });

  test("keeps the order the server gave", () => {
    const input = treeInputOf([
      { path: "src/b.ts", status: "deleted" },
      { path: "a.ts", status: "added" },
    ]);

    expect(input.paths).toStrictEqual(["src/b.ts", "a.ts"]);
  });

  test("an empty change list makes an empty tree", () => {
    expect(treeInputOf([])).toStrictEqual({ paths: [], gitStatus: [] });
  });
});

describe("review item", () => {
  test("draws a diff for a modified file", () => {
    const item = reviewItemOf(
      {
        newText: "one\ntwo\nthree\n",
        oldText: "one\ntwo\n",
        path: "src/a.ts",
      },
      1
    );

    expect(item?.type).toBe("diff");

    if (item?.type !== "diff") {
      throw new Error("expected a diff");
    }

    expect(item.fileDiff.name).toBe("a.ts");
    expect(item.fileDiff.hunks.length).toBeGreaterThan(0);
    expect(item.version).toBeTypeOf("number");
  });

  test("draws unchanged content as all additions", () => {
    const item = reviewItemOf(
      {
        newText: "same\n",
        oldText: "same\n",
        oldPath: "old.ts",
        path: "new.ts",
      },
      1
    );

    expect(item?.type).toBe("diff");

    if (item?.type !== "diff") {
      throw new Error("expected a diff");
    }

    expect(item.fileDiff.name).toBe("new.ts");
    expect(item.fileDiff.deletionLines).toStrictEqual([]);
    expect(item.fileDiff.additionLines).toStrictEqual(["same\n"]);
  });

  test("draws a file changed back to its baseline as all additions", () => {
    const item = reviewItemOf(
      {
        newText: "same\n",
        oldText: "same\n",
        path: "a.ts",
      },
      1
    );

    expect(item?.type).toBe("diff");

    if (item?.type !== "diff") {
      throw new Error("expected a diff");
    }

    expect(item.fileDiff.deletionLines).toStrictEqual([]);
  });

  test("draws a diff for an added file", () => {
    const item = reviewItemOf(
      {
        newText: "fresh\n",
        oldText: null,
        path: "fresh.md",
      },
      1
    );

    expect(item?.type).toBe("diff");
  });

  test("draws a diff for a deleted file", () => {
    const item = reviewItemOf(
      {
        newText: null,
        oldText: "gone\n",
        path: "gone.md",
      },
      1
    );

    expect(item?.type).toBe("diff");

    if (item?.type !== "diff") {
      throw new Error("expected a diff");
    }

    expect(item.fileDiff.name).toBe("gone.md");
  });

  test("has nothing to draw when neither side has text", () => {
    expect(
      reviewItemOf({ newText: null, oldText: null, path: "a.ts" }, 1)
    ).toBeNull();
  });

  test("counts the added and deleted lines", () => {
    const item = reviewItemOf(
      { newText: "one\ntwo\nthree\n", oldText: "one\ntwo\n", path: "a.ts" },
      1
    );

    if (item?.type !== "diff") {
      throw new Error("expected a diff");
    }

    expect(lineCountsOf(item.fileDiff)).toStrictEqual({ added: 1, deleted: 0 });
  });

  test("counts a deletion", () => {
    const item = reviewItemOf(
      { newText: null, oldText: "gone\n", path: "gone.md" },
      1
    );

    if (item?.type !== "diff") {
      throw new Error("expected a diff");
    }

    expect(lineCountsOf(item.fileDiff)).toStrictEqual({ added: 0, deleted: 1 });
  });

  test("counts unchanged content as all additions", () => {
    const item = reviewItemOf(
      { newText: "same\n", oldText: "same\n", path: "a.ts" },
      1
    );

    if (item?.type !== "diff") {
      throw new Error("expected a diff");
    }

    expect(lineCountsOf(item.fileDiff)).toStrictEqual({ added: 1, deleted: 0 });
  });

  test("uses the version it is given", () => {
    const item = reviewItemOf(
      { newText: "one\n", oldText: "zero\n", path: "a.ts" },
      7
    );

    expect(item?.version).toBe(7);
  });
});
