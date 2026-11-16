import { describe, expect, test } from "vitest";

import type { AgentToolSet } from "../src/tool-contracts";

const names = [
  "delete-file",
  "edit-file",
  "glob",
  "grep",
  "read-file",
  "write-file",
  "web-fetch",
  "load-skill",
  "job-output",
  "job-list",
  "job-kill",
  "questionnaire",
  "bash",
  "powershell",
  "task",
  "search-tools",
  "call-tool",
] as const satisfies readonly (keyof AgentToolSet)[];

// 集合是双向的：少一个名字，`names` 不满足 `keyof`；多一个名字，`Missing`
// 不是 `never`。两边的类型检查都在编译期完成。
type Missing = Exclude<keyof AgentToolSet, (typeof names)[number]>;
const complete: Missing extends never ? true : false = true;

describe("tool contracts", () => {
  test("covers every tool name exactly once", () => {
    expect(names).toHaveLength(17);
    expect(new Set(names).size).toBe(names.length);
    expect(complete).toBeTruthy();
  });
});
