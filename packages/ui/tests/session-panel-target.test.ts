import { describe, expect, test } from "vitest";

import { targetAfterSelect } from "../src/elements/session-panel/target";

describe("panel target", () => {
  test("a newly selected file has no range", () => {
    expect(targetAfterSelect(null, "a.ts")).toStrictEqual({ path: "a.ts" });
  });

  test("the same file keeps the range it was opened with", () => {
    const target = { endLine: 3, line: 1, path: "a.ts" };

    expect(targetAfterSelect(target, "a.ts")).toBe(target);
  });

  test("another file drops the previous range", () => {
    const target = { endLine: 3, line: 1, path: "a.ts" };

    expect(targetAfterSelect(target, "b.ts")).toStrictEqual({ path: "b.ts" });
  });

  test("clearing the selection clears the target", () => {
    expect(targetAfterSelect({ path: "a.ts" }, null)).toBeNull();
  });
});
