import { describe, expect, test } from "vitest";

import {
  ancestorDirectories,
  treePathOf,
} from "../src/elements/session-panel/reveal-path";
import { withView } from "../src/elements/session-panel/tabs";

describe("panel tab opening", () => {
  test("replaces the new-tab seat", () => {
    expect(withView(["new"], "files")).toStrictEqual(["files"]);
    expect(withView(["new", "terminal"], "files")).toStrictEqual([
      "files",
      "terminal",
    ]);
  });

  test("appends when no seat is free", () => {
    expect(withView(["terminal"], "files")).toStrictEqual([
      "terminal",
      "files",
    ]);
  });

  test("keeps an already open view once", () => {
    expect(withView(["files", "terminal"], "files")).toStrictEqual([
      "files",
      "terminal",
    ]);
  });

  test("does not change the input list", () => {
    const tabs = ["new"] as const;
    const next = withView(tabs, "files");

    expect(tabs).toStrictEqual(["new"]);
    expect(next).not.toBe(tabs);
  });
});

describe("file tree path", () => {
  test.each([
    ["a/b.ts", "a/b.ts"],
    ["./a/b.ts", "a/b.ts"],
  ])("accepts the workspace-relative %s", (path, expected) => {
    expect(treePathOf(path)).toBe(expected);
  });

  test.each([
    ["/a/b.ts"],
    ["C:/a/b.ts"],
    ["\\\\server\\share\\b.ts"],
    ["../a/b.ts"],
    ["a/../b.ts"],
    ["a//b.ts"],
    ["src/"],
    [""],
  ])("rejects %s", (path) => {
    expect(treePathOf(path)).toBeNull();
  });
});

describe("file tree ancestors", () => {
  test("lists every parent from the root down", () => {
    expect(ancestorDirectories("a/b/c.ts")).toStrictEqual(["a/", "a/b/"]);
  });

  test("stops at the root for a top-level file", () => {
    expect(ancestorDirectories("c.ts")).toStrictEqual([]);
  });
});
