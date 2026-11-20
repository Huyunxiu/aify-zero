import { describe, expect, test } from "vitest";

import { classifyAnnotations, classifyTool } from "../src/approval-classes.js";

describe(classifyTool, () => {
  test("reads are reads and writes are mutations", () => {
    expect(classifyTool("read-file")).toBe("read");
    expect(classifyTool("write-file")).toBe("mutate");
    expect(classifyTool("delete-file")).toBe("mutate");
  });

  test("a command is its own class", () => {
    expect(classifyTool("bash")).toBe("exec");
    expect(classifyTool("powershell")).toBe("exec");
  });

  test("an unknown tool is not treated as a read", () => {
    expect(classifyTool("mcp__linear__delete_issue")).toBe("unknown");
    expect(classifyTool("nothing-like-this")).toBe("unknown");
  });
});

describe(classifyAnnotations, () => {
  test("a destructive hint is a mutation", () => {
    expect(classifyAnnotations({ destructiveHint: true })).toBe("mutate");
  });

  test("a read-only hint is a read", () => {
    expect(classifyAnnotations({ readOnlyHint: true })).toBe("read");
  });

  test("no hint, or both, is unknown", () => {
    expect(classifyAnnotations()).toBe("unknown");
    expect(
      classifyAnnotations({ readOnlyHint: true, destructiveHint: true })
    ).toBe("mutate");
  });
});
