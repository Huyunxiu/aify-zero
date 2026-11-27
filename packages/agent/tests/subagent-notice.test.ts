import { describe, expect, test } from "vitest";

import {
  composeSubagentNotice,
  settledStatus,
  subagentNoticeRequest,
  waitingItems,
} from "../src/subagent/notice.js";

const settlement = (overrides: Record<string, unknown> = {}) => ({
  parentSessionId: "parent-1",
  sessionId: "child-1",
  name: "AGENT-1",
  subagentType: "explore",
  status: "done",
  report: "Found it in the router.",
  dropped: 0,
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

  test("says how many waiting items the run never read", () => {
    const notice = composeSubagentNotice(
      settlement({ status: "canceled", dropped: 2 })
    );

    expect(notice).toContain("It never read 2 waiting items; they are gone.");
  });

  test("says it in the singular for one item", () => {
    const notice = composeSubagentNotice(
      settlement({ status: "error", dropped: 1 })
    );

    expect(notice).toContain("It never read 1 waiting item; it is gone.");
  });

  test("says nothing about waiting items when none were left", () => {
    const notice = composeSubagentNotice(settlement({ status: "canceled" }));

    expect(notice).not.toContain("never read");
  });

  test("files each settlement under its own run", () => {
    const first = subagentNoticeRequest(settlement({ runKey: "turn-1" }));
    const second = subagentNoticeRequest(settlement({ runKey: "turn-2" }));

    expect(first.dedupeKey).not.toBe(second.dedupeKey);
  });

  test("files a settlement without a run under one key", () => {
    const first = subagentNoticeRequest(settlement());
    const second = subagentNoticeRequest(settlement());

    expect(first.dedupeKey).toBe(second.dedupeKey);
  });

  test("writes the dropped count the way the stop tool writes it", () => {
    expect(waitingItems(1)).toBe("1 waiting item");
    expect(waitingItems(3)).toBe("3 waiting items");
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
