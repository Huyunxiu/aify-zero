import { describe, expect, test } from "vitest";

import {
  publicJob,
  renderDelta,
  renderJobRead,
  statusLine,
} from "../../src/jobs/render.js";
import type { JobChunk, JobView } from "../../src/jobs/types.js";

const view = (overrides: Partial<JobView> = {}): JobView => ({
  id: "bash-0123456789abcdef",
  kind: "bash",
  label: "sleep 60",
  status: "running",
  startedAt: 1,
  output: { total: 0, earliest: 0, unreadBytes: 0 },
  ...overrides,
});

const chunk = (text: string, overrides: Partial<JobChunk> = {}): JobChunk => ({
  at: 0,
  text,
  ...overrides,
});

describe(publicJob, () => {
  test("keeps progress out of detail and renders it beside the status", () => {
    const job = publicJob(view({ progress: "3/10" }));
    expect(job.progress).toBe("3/10");
    expect(job.detail).toBeUndefined();
    expect(statusLine(job)).toBe("[status: running, 3/10]");
  });

  test("appends a note after the qualifier", () => {
    const job = publicJob(view({ progress: "3/10" }));
    expect(statusLine(job, "user steered")).toBe(
      "[status: running, 3/10; user steered]"
    );
  });

  test("falls back to the terminal detail once progress is cleared", () => {
    const settled = view({
      status: "completed",
      detail: "exit code: 0",
      finishedAt: 2,
    });
    expect(publicJob(settled).detail).toBe("exit code: 0");
  });
});

describe(renderDelta, () => {
  test("keeps stdout first and one stderr section", () => {
    const text = renderDelta(
      [
        chunk("out\n", { channel: "stdout" }),
        chunk("err\n", { channel: "stderr", at: 4 }),
      ],
      false,
      []
    );
    expect(text).toBe("out\n[stderr]\nerr\n");
  });

  test("never renders producer narration", () => {
    expect(renderDelta([chunk("note", { channel: "log" })], false, [])).toBe(
      ""
    );
  });

  test("names the full output file when the cursor fell behind the ring", () => {
    expect(renderDelta([chunk("tail")], true, ["/tmp/s/jobs/bash.log"])).toBe(
      "tail\n[some output was dropped from memory; full output: /tmp/s/jobs/bash.log]"
    );
  });

  test("reports a producer-side gap even when the read is not lossy", () => {
    expect(
      renderDelta([chunk("tail", { gapBefore: true })], false, [
        "/tmp/s/jobs/bash.log",
      ])
    ).toBe(
      "tail\n[some output was dropped from memory; full output: /tmp/s/jobs/bash.log]"
    );
  });

  test("says the full output is unavailable when no file is known", () => {
    expect(renderDelta([chunk("tail")], true, [])).toBe(
      "tail\n[some output was dropped from memory; full output: (unavailable)]"
    );
  });
});

describe(renderJobRead, () => {
  test("appends the result after the delta and before the status", () => {
    const text = renderJobRead({
      chunks: [chunk("done\n")],
      lossy: false,
      result: "the answer",
      job: view({
        status: "completed",
        detail: "exit code: 0",
        finishedAt: 2,
      }),
    });
    expect(text).toBe("done\nthe answer\n[status: completed, exit code: 0]");
  });
});
