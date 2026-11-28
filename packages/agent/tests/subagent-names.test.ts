import { describe, expect, test } from "vitest";

import {
  formatSubagentName,
  normalizeSubagentName,
  nextSubagentName,
} from "../src/subagent/names.js";

describe(formatSubagentName, () => {
  test("numbers from one upward", () => {
    expect(formatSubagentName(1)).toBe("AGENT-1");
    expect(formatSubagentName(12)).toBe("AGENT-12");
  });

  test("refuses a number no subagent can hold", () => {
    expect(() => formatSubagentName(0)).toThrow(/starts at 1/);
  });
});

describe(nextSubagentName, () => {
  test("starts at the first number when the parent has no children", () => {
    expect(nextSubagentName([])).toBe("AGENT-1");
  });

  test("takes the smallest free number, so a gap is filled before a new one is made", () => {
    expect(nextSubagentName(["AGENT-1", "AGENT-3"])).toBe("AGENT-2");
  });

  test("counts past a run of taken names", () => {
    expect(nextSubagentName(["AGENT-1", "AGENT-2", "AGENT-3"])).toBe("AGENT-4");
  });

  test("ignores a child that has no name, which is every row written before names", () => {
    expect(nextSubagentName([null, "AGENT-1"])).toBe("AGENT-2");
  });
});

describe(normalizeSubagentName, () => {
  test("folds what a model typed into the form the row holds", () => {
    expect(normalizeSubagentName("  agent-2 ")).toBe("AGENT-2");
  });

  test("leaves a name that is already canonical alone", () => {
    expect(normalizeSubagentName("AGENT-2")).toBe("AGENT-2");
  });
});
