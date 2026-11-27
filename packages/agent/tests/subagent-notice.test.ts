import { describe, expect, test } from "vitest";

import {
  composeSubagentNotice,
  settledStatus,
} from "../src/subagent/notice.js";

const settlement = (overrides: Record<string, unknown> = {}) => ({
  parentSessionId: "parent-1",
  sessionId: "child-1",
  name: "AGENT-1",
  subagentType: "explore",
  status: "done",
  report: "Found it in the router.",
  ...overrides,
});

describe(composeSubagentNotice, () => {
  test("names the subagent, its type, and how it settled, then the report as it said it", () => {
    expect(composeSubagentNotice(settlement())).toBe(
      [
        "subagent AGENT-1 (explore) settled: done",
        "",
        "Found it in the router.",
      ].join("\n")
    );
  });

  test("says so when nothing came back", () => {
    const notice = composeSubagentNotice(
      settlement({ status: "aborted", report: "   " })
    );

    expect(notice).toContain("settled: aborted");
    expect(notice).toContain("finished without a report");
  });

  test("cuts a report that is too long and says it did", () => {
    const notice = composeSubagentNotice(
      settlement({ report: "x".repeat(9000) })
    );

    expect(notice).toContain("[report truncated]");
    expect(notice.length).toBeLessThan(4200);
  });
});

describe(settledStatus, () => {
  test("turns a clean finish that carried no report into a failure", () => {
    expect(settledStatus("done", "   ")).toBe("error");
  });

  test("leaves a clean finish that said something alone", () => {
    expect(settledStatus("done", "Found it.")).toBe("done");
  });

  test("keeps a status the run already earned", () => {
    expect(settledStatus("aborted", "")).toBe("aborted");
  });
});
