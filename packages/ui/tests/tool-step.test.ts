import type { AgentToolSet } from "@workspace/agent";
import type { AgentAssistantStep, AgentPart } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import type { StepRow } from "../src/elements/tool-step";
import {
  formatDuration,
  getPartDurationMs,
  getPartStatus,
  getPartSummary,
  summarizeTurn,
} from "../src/elements/tool-step";

/**
 * Builds a part from the fields a case cares about. Cast through the real union
 * rather than restating it: the module under test is what decides how these are
 * read, and a test that re-declared the shape would agree with itself.
 */
const part = (fields: Record<string, unknown>): AgentPart<AgentToolSet> =>
  ({
    rawInput: "",
    toolCallId: "call-1",
    ...fields,
  }) as AgentPart<AgentToolSet>;

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
): AgentPart<AgentToolSet> =>
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

describe(getPartSummary, () => {
  test("should say a held call is waiting on the user", () => {
    expect(
      getPartSummary(
        part({
          type: "tool-bash",
          state: "approval-requested",
          approval: { id: "ap-1", createdAt: 1000 },
        })
      )
    ).toBe("awaiting approval");
  });

  test("should say nothing for a call the user is not being asked about", () => {
    expect(
      getPartSummary(
        part({
          type: "tool-bash",
          state: "approval-requested",
          approval: { id: "ap-1", isAutomatic: true, createdAt: 1000 },
        })
      )
    ).toBeUndefined();
  });

  test("should say nothing for a tool that has not finished", () => {
    expect(
      getPartSummary(part({ type: "tool-bash", state: "input-available" }))
    ).toBeUndefined();
  });

  test("should say nothing for a tool whose output is an error", () => {
    expect(
      getPartSummary(
        part({
          type: "tool-bash",
          state: "output-available",
          output: { code: "error", output: "no" },
        })
      )
    ).toBeUndefined();
  });

  test("should say nothing for a turn persisted before metadata existed", () => {
    expect(
      getPartSummary(
        part({
          type: "tool-read-file",
          state: "output-available",
          output: { code: "ok", output: "contents" },
        })
      )
    ).toBeUndefined();
  });

  describe("read-file", () => {
    const readFile = (metadata: unknown) =>
      getPartSummary(doneTool("tool-read-file", metadata));

    test("should count the lines of a file read whole", () => {
      expect(
        readFile({ type: "file", truncated: false, totalLines: 240 })
      ).toBe("240 lines");
    });

    test("should say a truncated read is partial", () => {
      expect(readFile({ type: "file", truncated: true, totalLines: 240 })).toBe(
        "240 lines · partial"
      );
    });

    test("should not invent a total when the byte cap hid it", () => {
      expect(readFile({ type: "file", truncated: true })).toBe("truncated");
    });

    test("should say nothing about a file whose length is unknown and was not cut", () => {
      expect(readFile({ type: "file", truncated: false })).toBeUndefined();
    });

    test("should count directory entries", () => {
      expect(
        readFile({ type: "directory", truncated: false, totalEntries: 18 })
      ).toBe("18 entries");
    });

    test("should show how much of a truncated directory listing was returned", () => {
      expect(
        readFile({
          type: "directory",
          truncated: true,
          entries: ["a", "b", "c"],
          totalEntries: 120,
        })
      ).toBe("3 of 120 entries");
    });

    test("should name the other read outcomes", () => {
      expect(readFile({ type: "miss" })).toBe("not found");
      expect(readFile({ type: "attachments", mime: "image/png" })).toBe(
        "image/png"
      );
      expect(readFile({ type: "binary-file" })).toBe("binary file");
    });
  });

  describe("load-skill", () => {
    test("should name the skill rather than describe the file it read", () => {
      const summary = getPartSummary(
        doneTool(
          "tool-load-skill",
          { type: "file", truncated: false, totalLines: 240 },
          {
            input: { skill: "code-review" },
          }
        )
      );
      expect(summary).toBe("code-review");
    });

    test("should fall back to the read summary for a skill with no name", () => {
      const summary = getPartSummary(
        doneTool("tool-load-skill", {
          type: "file",
          truncated: false,
          totalLines: 240,
        })
      );
      expect(summary).toBe("240 lines");
    });
  });

  describe("grep", () => {
    const grep = (metadata: unknown, input: Record<string, unknown> = {}) =>
      getPartSummary(doneTool("tool-grep", metadata, { input }));

    test("should say there were no matches", () => {
      expect(grep({ matchCount: 0 })).toBe("no matches");
    });

    test("should count matching lines rather than claiming matches", () => {
      expect(grep({ matchCount: 12 })).toBe("12 matching lines");
    });

    test("should say lines with context when context was requested", () => {
      expect(grep({ matchCount: 40 }, { context: 3 })).toBe(
        "40 lines (with context)"
      );
    });

    test("should mark a capped count as a lower bound", () => {
      expect(grep({ matchCount: 200, truncatedByLines: true })).toBe(
        "200+ matching lines"
      );
    });
  });

  describe("glob", () => {
    const glob = (metadata: unknown) =>
      getPartSummary(doneTool("tool-glob", metadata));

    test("should say there were no files", () => {
      expect(glob({ count: 0 })).toBe("no files");
    });

    test("should count files", () => {
      expect(glob({ count: 12 })).toBe("12 files");
    });

    test("should mark a capped count as a lower bound", () => {
      expect(glob({ count: 500, truncatedByBytes: true })).toBe("500+ files");
    });
  });

  describe("bash", () => {
    const bash = (metadata: unknown) =>
      getPartSummary(doneTool("tool-bash", metadata));

    test("should report a timeout", () => {
      expect(bash({ timeout: true })).toBe("timed out");
    });

    test("should report an abort", () => {
      expect(bash({ aborted: true })).toBe("aborted");
    });

    test("should report a nonzero exit", () => {
      expect(bash({ exitCode: 1 })).toBe("exit 1");
    });

    test("should say nothing for a command that succeeded", () => {
      expect(bash({ exitCode: 0 })).toBeUndefined();
    });

    test("should say nothing when the command never reported an exit code", () => {
      expect(bash({ exitCode: null })).toBeUndefined();
    });
  });

  describe("web-fetch", () => {
    test("should prefer the page title", () => {
      expect(
        getPartSummary(
          doneTool("tool-web-fetch", { title: "Example", url: "https://e.com" })
        )
      ).toBe("Example");
    });

    test("should fall back to the url and mark a truncated body", () => {
      expect(
        getPartSummary(
          doneTool("tool-web-fetch", {
            title: "",
            url: "https://e.com",
            truncated: true,
          })
        )
      ).toBe("https://e.com (truncated)");
    });
  });

  describe("edit-file", () => {
    test("should show the line delta", () => {
      expect(
        getPartSummary(
          doneTool("tool-edit-file", {
            replacements: 1,
            linesAdded: 12,
            linesRemoved: 4,
          })
        )
      ).toBe("+12 −4");
    });

    test("should note how many times a replace-all edit landed", () => {
      expect(
        getPartSummary(
          doneTool("tool-edit-file", {
            replacements: 2,
            linesAdded: 3,
            linesRemoved: 1,
          })
        )
      ).toBe("+3 −1 · 2×");
    });
  });

  describe("write-file", () => {
    test("should distinguish a created file from an updated one", () => {
      expect(
        getPartSummary(
          doneTool("tool-write-file", { created: true, lines: 42 })
        )
      ).toBe("created · 42 lines");
      expect(
        getPartSummary(
          doneTool("tool-write-file", { created: false, lines: 7 })
        )
      ).toBe("updated · 7 lines");
    });

    test("should omit the line count for an empty file", () => {
      expect(
        getPartSummary(doneTool("tool-write-file", { created: true, lines: 0 }))
      ).toBe("created");
    });
  });

  describe("delete-file", () => {
    test("should name what was deleted", () => {
      expect(
        getPartSummary(doneTool("tool-delete-file", { kind: "directory" }))
      ).toBe("directory deleted");
      expect(
        getPartSummary(doneTool("tool-delete-file", { kind: "file" }))
      ).toBe("file deleted");
    });
  });

  describe("task", () => {
    const task = (extra: Record<string, unknown>) =>
      part({
        type: "tool-task",
        input: { subagent_type: "explore", description: "find the parser" },
        ...extra,
      });

    test("should name the subagent while it is still running", () => {
      // The one tool that reports before it finishes: its label holds the
      // description the model wrote, which does not say which subagent ran.
      expect(getPartSummary(task({ state: "input-available" }))).toBe(
        "explore"
      );
    });

    test("should name the subagent while it is only reporting part-way", () => {
      // The same call in its next state: the first report is the session it
      // started, not an answer, and the row still has to say who is at work.
      expect(
        getPartSummary(
          task({
            state: "output-available",
            preliminary: true,
            output: {
              code: "ok",
              output: "",
              metadata: { status: "running" },
            },
          })
        )
      ).toBe("explore");
    });

    test("should name the subagent it delegated to", () => {
      expect(
        getPartSummary(
          doneTool(
            "tool-task",
            { status: "done" },
            {
              input: { subagent_type: "general" },
            }
          )
        )
      ).toBe("general");
    });

    test("should say nothing for a subagent that did not finish", () => {
      // A subagent held on an approval, or one that failed, comes back as
      // `code: "error"` — the row's own `Failed` carries that.
      expect(
        getPartSummary(
          part({
            type: "tool-task",
            state: "output-available",
            input: { subagent_type: "general" },
            output: {
              code: "error",
              output: "",
              metadata: { status: "error" },
            },
          })
        )
      ).toBeUndefined();
    });
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
