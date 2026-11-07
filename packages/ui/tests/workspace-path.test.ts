import { describe, expect, test } from "vitest";

import {
  ancestorDirectories,
  linkPathOf,
  treePathOf,
} from "../src/lib/workspace-path";

describe("link path", () => {
  test("writes forward slashes and drops a leading ./", () => {
    expect(linkPathOf("./src/index.ts")).toBe("src/index.ts");
    expect(linkPathOf("src\\index.ts")).toBe("src/index.ts");
  });

  test("drops the trailing slash of a directory", () => {
    expect(linkPathOf("packages/ui/")).toBe("packages/ui");
  });

  test("keeps the root slash", () => {
    expect(linkPathOf("/")).toBe("/");
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
