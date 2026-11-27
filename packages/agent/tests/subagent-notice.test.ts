import { describe, expect, test } from "vitest";

import { composeSubagentNotice } from "../src/subagent/notice.js";

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

  test("says a clean finish that carried no report apart from a lost one", () => {
    const notice = composeSubagentNotice(settlement({ report: "   " }));

    expect(notice).toContain("settled: done");
    expect(notice).toContain("finished without a report");
  });

  test("keeps the status word when the run did not finish cleanly", () => {
    const notice = composeSubagentNotice(
      settlement({ status: "aborted", report: "" })
    );

    expect(notice).toContain("settled: aborted");
    expect(notice).toContain("reported nothing");
  });

  test("cuts a report that is too long and says it did", () => {
    const notice = composeSubagentNotice(
      settlement({ report: "x".repeat(9000) })
    );

    expect(notice).toContain("[report truncated]");
    expect(notice.length).toBeLessThan(4200);
  });
});
