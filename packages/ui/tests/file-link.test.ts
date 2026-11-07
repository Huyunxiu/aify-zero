import { describe, expect, test } from "vitest";

import { classifyMarkdownHref, parseFileLink } from "../src/elements/file-link";

/** 拆开写，避免 lint 把测试里的字符串当成真的脚本地址。 */
const SCRIPT_HREF = ["java", "script:alert(1)"].join("");

describe("file link parsing", () => {
  test.each([
    ["src/index.ts", "src/index.ts", undefined],
    ["src/index.ts:24", "src/index.ts", 24],
    ["src/index.ts:24-30", "src/index.ts", 24],
    ["src/index.ts:24:5", "src/index.ts", 24],
    ["/workspace/src/index.ts:24", "/workspace/src/index.ts", 24],
    ["./README:12", "README", 12],
    ["../docs/My%20Notes.md#L24-L30", "../docs/My Notes.md", 24],
    ["file.ts#L024", "file.ts", 24],
    ["index%2Ets", "index.ts", undefined],
    ["docs/notes%3A24", "docs/notes:24", undefined],
    ["docs/notes%3A24:30", "docs/notes:24", 30],
    ["docs/notes:24#L3", "docs/notes:24", 3],
    ["C:/work/file.ts:2", "C:/work/file.ts", 2],
    ["C:%5Cwork%5Cfile.ts", "C:/work/file.ts", undefined],
    ["src%5Cindex.ts", "src/index.ts", undefined],
    ["file%23name%3F.txt", "file#name?.txt", undefined],
    ["packages/ui/", "packages/ui", undefined],
  ])("reads %s as a file target", (destination, path, line) => {
    const target = parseFileLink(destination);

    expect(target).not.toBeNull();
    expect(target?.path).toBe(path);
    expect(target?.line).toBe(line);
  });

  test.each([["src/index.ts?raw=1"], ["%zz"], [""], ["\u0001x"], ["#L3"]])(
    "rejects %s",
    (destination) => {
      expect(parseFileLink(destination)).toBeNull();
    }
  );

  test.each([
    ["file.ts#heading", "file.ts"],
    ["file.ts#L0", "file.ts"],
    ["file.ts#L3-L2", "file.ts"],
    ["src/index.ts:0", "src/index.ts"],
    ["src/index.ts:30-24", "src/index.ts"],
    ["src/index.ts:9007199254740992", "src/index.ts"],
  ])("keeps %s as the path only", (destination, path) => {
    expect(parseFileLink(destination)).toStrictEqual({ path });
  });
});

describe("markdown target classification", () => {
  test.each([
    ["src/index.ts:3", "file"],
    ["C:\\work\\file.ts", "file"],
    ["https://example.com/a", "external"],
    ["mailto:someone@example.com", "external"],
    ["#section", "plain"],
    ["notes?view=raw", "plain"],
    [SCRIPT_HREF, "blocked"],
    ["data:text/html,hi", "blocked"],
    ["localhost:3000", "blocked"],
    ["", "plain"],
  ])("classifies %s as %s", (href, kind) => {
    expect(classifyMarkdownHref(href).kind).toBe(kind);
  });
});
