import { describe, expect, test } from "vitest";

import { composeJobNotice } from "../../src/jobs/notice.js";
import type { JobRead, JobView } from "../../src/jobs/types.js";

const view = (overrides: Partial<JobView> = {}): JobView => ({
  id: "bash-0123456789abcdef",
  kind: "bash",
  label: "npm run build",
  status: "completed",
  detail: "exit code: 0",
  startedAt: 1,
  finishedAt: 2,
  output: { total: 6, earliest: 0, unreadBytes: 6 },
  ...overrides,
});

const read = (): JobRead => ({
  chunks: [{ at: 0, text: "done\n", channel: "stdout" }],
  lossy: false,
  result: "3 packages built",
  job: view(),
});

describe(composeJobNotice, () => {
  test("inlines unread output and the terminal result when they fit", () => {
    const notice = composeJobNotice({ job: view(), readOutput: read });

    expect(notice.inline).toBeTruthy();
    expect(notice.text).toContain(
      "background job bash-0123456789abcdef (bash: npm run build) finished [status: completed, exit code: 0]"
    );
    expect(notice.text).toContain("done");
    expect(notice.text).toContain("3 packages built");
  });

  test("inlines only the bytes the model has not read yet", () => {
    // 任务总共产出过 100 字节，但模型已经读过 94 字节：剩下的 6 字节放得下。
    const notice = composeJobNotice({
      job: view({
        output: { total: 100, earliest: 0, unreadBytes: 6 },
      }),
      readOutput: read,
    });

    expect(notice.inline).toBeTruthy();
  });

  test("inlines a pending result even when no output is left", () => {
    const notice = composeJobNotice({
      job: view({
        output: { total: 0, earliest: 0, unreadBytes: 0 },
        resultBytes: 16,
      }),
      readOutput: read,
    });

    expect(notice.inline).toBeTruthy();
    expect(notice.text).toContain("3 packages built");
  });

  test("says there is no new output when nothing is pending", () => {
    const notice = composeJobNotice({
      job: view({ output: { total: 0, earliest: 0, unreadBytes: 0 } }),
      readOutput: read,
    });

    expect(notice.inline).toBeFalsy();
    expect(notice.text).toContain("No new output.");
  });

  test("points at job-output without consuming output that cannot fit", () => {
    let readCalls = 0;
    const notice = composeJobNotice({
      job: view({
        output: { total: 50_000, earliest: 0, unreadBytes: 50_000 },
      }),
      readOutput: () => {
        readCalls += 1;
        return read();
      },
    });

    expect(notice.inline).toBeFalsy();
    expect(notice.text).toContain("Read its output with job-output.");
    expect(readCalls).toBe(0);
  });

  test("points at job-output when no reader is available", () => {
    const notice = composeJobNotice({ job: view() });

    expect(notice.inline).toBeFalsy();
    expect(notice.text).toContain("job-output");
  });

  test("respects a producer's smaller output limit", () => {
    const notice = composeJobNotice({
      job: view({ outputLimitBytes: 64 }),
      readOutput: read,
    });

    expect(notice.inline).toBeFalsy();
    expect(Buffer.byteLength(notice.text, "utf-8")).toBeLessThanOrEqual(
      64 + 64
    );
  });

  test("keeps only the label's first line", () => {
    const notice = composeJobNotice({
      job: view({ label: "npm run build\nsecond line" }),
    });

    expect(notice.text).not.toContain("second line");
    expect(notice.text).toContain("npm run build");
  });
});
