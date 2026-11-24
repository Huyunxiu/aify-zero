import type { AgentAssistantStep, AgentToolSet } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import type { StepPart } from "../src/blocks/steps/types";
import type { StepRow } from "../src/blocks/tool-step";
import {
  formatDuration,
  getPartDurationMs,
  getPartStatus,
  summarizeTurn,
} from "../src/blocks/tool-step";

/**
 * Builds a part from the fields a case cares about. Cast through the real union
 * rather than restating it: the module under test is what decides how these are
 * read, and a test that re-declared the shape would agree with itself.
 */
const part = (fields: Record<string, unknown>): StepPart =>
  ({
    rawInput: "",
    toolCallId: "call-1",
    ...fields,
  }) as StepPart;

const step = (fields: Record<string, unknown> = {}): StepRow["step"] =>
  ({
    type: "assistant",
    id: "step-1",
    model: "test-model",
    status: "done",
    createdAt: 1000,
    content: [],
    ...fields,
  }) as AgentAssistantStep<AgentToolSet>;

/** A finished tool call with the given metadata, in the shape a tool returns. */
const doneTool = (
  type: string,
  metadata: unknown,
  extra: Record<string, unknown> = {}
): StepPart =>
  part({
    type,
    state: "output-available",
    input: {},
    output: { code: "ok", output: "", metadata },
    ...extra,
  });

describe(getPartStatus, () => {
  test("should report a tool that has not been called yet as running", () => {
    expect(
      getPartStatus(part({ type: "tool-read-file", state: "input-streaming" }))
    ).toBe("running");
  });

  test("should report a tool that is executing as running", () => {
    expect(
      getPartStatus(part({ type: "tool-read-file", state: "input-available" }))
    ).toBe("running");
  });

  test("should report a tool that returned a result as complete", () => {
    expect(
      getPartStatus(
        part({
          type: "tool-read-file",
          state: "output-available",
          output: { code: "ok", output: "" },
        })
      )
    ).toBe("complete");
  });

  test("should report a tool that reported part-way through as running", () => {
    // A `task` call publishes the subagent it started before it has an answer,
    // so the part is in `output-available` while the call is still going.
    // Reading the state alone would call the row finished the moment it first
    // reported.
    expect(
      getPartStatus(
        part({
          type: "tool-task",
          state: "output-available",
          preliminary: true,
          input: { subagent_type: "explore" },
          output: { code: "ok", output: "", metadata: { status: "running" } },
        })
      )
    ).toBe("running");
  });

  test("should report a preliminary report as aborted once the turn has settled", () => {
    // 进程被杀时落库的就是这个样子：preliminary 那份是最后一份，最终结果再也
    // 没来。turn 已经落定，行不该继续转圈。
    const reportingTask = part({
      type: "tool-task",
      state: "output-available",
      preliminary: true,
      input: { subagent_type: "explore" },
      output: { code: "ok", output: "", metadata: { status: "running" } },
    });

    expect(getPartStatus(reportingTask, "aborted")).toBe("aborted");
    expect(getPartStatus(reportingTask, "error")).toBe("aborted");

    // 还在跑的那一轮不算：后面还有报告要来。
    expect(getPartStatus(reportingTask, "streaming")).toBe("running");
    // wait_review 也没落定——那一轮停在等用户回答，答完还有一段流接着跑。
    expect(getPartStatus(reportingTask, "wait_review")).toBe("running");
    // 统计用的那些调用点拿不到 turn 状态，保持原样。
    expect(getPartStatus(reportingTask)).toBe("running");
  });

  test("should report a task whose subagent was stopped as aborted, not failed", () => {
    // 父会话一停，signal 传导下去把子 agent 一起停了，`task` 于是拿着一份
    // "没有报告"回来。`code: "error"` 在这里说的是"没拿到结果"。
    expect(
      getPartStatus(
        part({
          type: "tool-task",
          state: "output-available",
          input: { subagent_type: "explore" },
          output: {
            code: "error",
            output: "The explore subagent finished without a report.",
            metadata: { status: "aborted", sessionId: "child-1" },
          },
        })
      )
    ).toBe("aborted");
  });

  test("should report a tool that ran and reported an error as failed", () => {
    // Glob and read-file resolve `code: "error"` for a bad path, so the part
    // stays in `output-available` — reading only `state` would call it complete.
    expect(
      getPartStatus(
        part({
          type: "tool-glob",
          state: "output-available",
          output: { code: "error", output: "bad path" },
        })
      )
    ).toBe("failed");
  });

  test("should report a tool that threw as failed", () => {
    expect(
      getPartStatus(
        part({ type: "tool-bash", state: "output-error", errorText: "boom" })
      )
    ).toBe("failed");
  });

  test("should report a tool that was denied as denied", () => {
    expect(
      getPartStatus(part({ type: "tool-bash", state: "output-denied" }))
    ).toBe("denied");
  });

  test("should report a call held for the user as awaiting approval", () => {
    expect(
      getPartStatus(
        part({
          type: "tool-bash",
          state: "approval-requested",
          approval: { id: "ap-1", createdAt: 1000 },
        })
      )
    ).toBe("approval");
  });

  test("should not ask the user about a call a policy already approved", () => {
    // The auto-approval is not the user's to give, so the row is work under
    // way rather than a question.
    expect(
      getPartStatus(
        part({
          type: "tool-bash",
          state: "approval-requested",
          approval: { id: "ap-1", isAutomatic: true, createdAt: 1000 },
        })
      )
    ).toBe("running");
  });

  test("should read an answered approval as the answer", () => {
    expect(
      getPartStatus(
        part({
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap-1", approved: true, createdAt: 1000 },
        })
      )
    ).toBe("running");
    expect(
      getPartStatus(
        part({
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap-1", approved: false, createdAt: 1000 },
        })
      )
    ).toBe("denied");
  });

  test("should take a streaming text part as running and a finished one as complete", () => {
    expect(getPartStatus(part({ type: "text", state: "streaming" }))).toBe(
      "running"
    );
    expect(getPartStatus(part({ type: "text", state: "done" }))).toBe(
      "complete"
    );
  });

  test("should treat a session title part as complete", () => {
    expect(getPartStatus(part({ type: "session.title", id: "t" }))).toBe(
      "complete"
    );
  });
});

describe(getPartDurationMs, () => {
  test("should use the runtime's per-call figure when it recorded one", () => {
    const call = part({
      type: "tool-bash",
      state: "output-available",
      toolCallId: "call-9",
    });
    const owner = step({
      // Where the runtime writes it: the step's `metadata`, not the step.
      metadata: { performance: { toolExecutionMs: { "call-9": 1234 } } },
      completedAt: 9999,
    });
    expect(getPartDurationMs(call, owner)).toBe(1234);
  });

  test("should report nothing rather than the step's span when the call has no figure of its own", () => {
    // The span also covers the model writing the call, so it would overstate
    // the tool. An empty cell beats a wrong measurement.
    const call = doneTool("tool-bash", undefined, { toolCallId: "call-9" });
    const owner = step({
      createdAt: 1000,
      completedAt: 1500,
      content: [call],
      metadata: { performance: { toolExecutionMs: {} } },
    });
    expect(getPartDurationMs(call, owner)).toBeUndefined();
  });

  test("should report no figure for a step from before timings were recorded", () => {
    const call = doneTool("tool-bash", undefined, { toolCallId: "call-9" });
    const owner = step({ createdAt: 1000, completedAt: 1500, content: [call] });
    expect(getPartDurationMs(call, owner)).toBeUndefined();
  });

  test("should report no figure for a tool still running", () => {
    const call = part({ type: "tool-bash", state: "input-available" });
    const owner = step({ createdAt: 1000, content: [call] });
    expect(getPartDurationMs(call, owner)).toBeUndefined();
  });

  test("should measure a text part by its own span", () => {
    const text = part({
      type: "text",
      text: "hi",
      state: "done",
      createdAt: 1000,
      completedAt: 2500,
    });
    expect(getPartDurationMs(text, step())).toBe(1500);
  });

  test("should measure a reasoning part by its own span", () => {
    const reasoning = part({
      type: "reasoning",
      text: "hmm",
      state: "done",
      createdAt: 1000,
      completedAt: 1400,
    });
    expect(getPartDurationMs(reasoning, step())).toBe(400);
  });

  test("should report no figure for a text part the stream never ended", () => {
    const text = part({
      type: "text",
      text: "hi",
      state: "streaming",
      createdAt: 1000,
    });
    expect(getPartDurationMs(text, step())).toBeUndefined();
  });

  test("should report no figure for a text part from before parts carried times", () => {
    // A `NaN` here would render as a measurement, which is worse than a blank.
    const text = part({
      type: "text",
      text: "hi",
      state: "done",
      completedAt: 2500,
    });
    expect(getPartDurationMs(text, step())).toBeUndefined();
  });

  test("should report no figure for a part that carries no times", () => {
    const title = part({ type: "session.title", id: "t", state: "done" });
    expect(
      getPartDurationMs(title, step({ completedAt: 1500 }))
    ).toBeUndefined();
  });
});

describe(formatDuration, () => {
  test("should stay in milliseconds below a second", () => {
    expect(formatDuration(850)).toBe("850ms");
  });

  test("should keep a tenth of a second up to ten seconds", () => {
    expect(formatDuration(4200)).toBe("4.2s");
  });

  test("should drop a zero tenth, so a live timer does not read 3.0s", () => {
    expect(formatDuration(3000)).toBe("3s");
  });

  test("should drop the fraction past ten seconds", () => {
    expect(formatDuration(42_400)).toBe("42s");
  });

  test("should pad the seconds past a minute", () => {
    expect(formatDuration(187_000)).toBe("3m 07s");
  });

  test("should switch to hours past an hour", () => {
    expect(formatDuration(4_320_000)).toBe("1h 12m");
  });
});

describe(summarizeTurn, () => {
  test("should say nothing for a turn that called no tools", () => {
    expect(
      summarizeTurn([
        { part: part({ type: "text", text: "hi" }), step: step() },
      ])
    ).toBeUndefined();
  });

  test("should count the tools a turn called", () => {
    const rows: StepRow[] = [
      { part: doneTool("tool-read-file", {}), step: step() },
      { part: doneTool("tool-glob", {}), step: step() },
    ];
    expect(summarizeTurn(rows)).toBe("2 tools");
  });

  test("should count distinct files, not edit calls", () => {
    const rows: StepRow[] = [
      {
        part: doneTool("tool-edit-file", {}, { input: { path: "src/a.ts" } }),
        step: step(),
      },
      {
        part: doneTool("tool-edit-file", {}, { input: { path: "src/a.ts" } }),
        step: step(),
      },
      {
        part: doneTool("tool-write-file", {}, { input: { path: "src/b.ts" } }),
        step: step(),
      },
    ];
    expect(summarizeTurn(rows)).toBe("3 tools · 2 files changed");
  });

  test("should not count a read as a changed file", () => {
    const rows: StepRow[] = [
      {
        part: doneTool("tool-read-file", {}, { input: { path: "src/a.ts" } }),
        step: step(),
      },
    ];
    expect(summarizeTurn(rows)).toBe("1 tool");
  });

  test("should count failures and denials", () => {
    const rows: StepRow[] = [
      {
        part: part({
          type: "tool-glob",
          state: "output-available",
          output: { code: "error", output: "bad" },
        }),
        step: step(),
      },
      {
        part: part({ type: "tool-bash", state: "output-denied" }),
        step: step(),
      },
      { part: doneTool("tool-read-file", {}), step: step() },
    ];
    expect(summarizeTurn(rows)).toBe("3 tools · 2 failed");
  });

  test("should say how much of the turn is waiting on the user", () => {
    const rows: StepRow[] = [
      {
        part: part({
          type: "tool-bash",
          state: "approval-requested",
          approval: { id: "ap-1", createdAt: 1000 },
        }),
        step: step(),
      },
      { part: doneTool("tool-read-file", {}), step: step() },
    ];
    expect(summarizeTurn(rows)).toBe("2 tools · 1 awaiting approval");
  });
});
