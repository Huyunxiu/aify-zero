import { createElement, Fragment } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { deleteFileSummary } from "../../src/elements/steps/delete-file";
import { editFileSummary } from "../../src/elements/steps/edit-file";
import { globSummary } from "../../src/elements/steps/glob";
import { grepSummary } from "../../src/elements/steps/grep";
import { loadSkillSummary } from "../../src/elements/steps/load-skill";
import { questionnaireSummary } from "../../src/elements/steps/questionnaire";
import { readFileSummary } from "../../src/elements/steps/read-file";
import { shellSummary } from "../../src/elements/steps/shell-tool";
import {
  finishedOutput,
  pendingSummary,
} from "../../src/elements/steps/summary";
import { taskSummary } from "../../src/elements/steps/task";
import type { StepPart, StepPartOf } from "../../src/elements/steps/types";
import { webFetchSummary } from "../../src/elements/steps/web-fetch";
import { writeFileSummary } from "../../src/elements/steps/write-file";

/**
 * The visible text of a summary. The edit summary is JSX so its delta can be
 * coloured; comparing the element itself would test the markup, not the words.
 */
const summaryText = (summary: ReactNode): string =>
  renderToStaticMarkup(createElement(Fragment, null, summary)).replace(
    /<[^>]+>/gu,
    ""
  );

/**
 * Builds a part from the fields a case cares about, cast through the real union
 * rather than restating it: a test that re-declared the shape would agree with
 * itself.
 */
const part = <TYPE extends StepPart["type"]>(
  fields: { type: TYPE } & Record<string, unknown>
): StepPartOf<TYPE> =>
  ({ rawInput: "", toolCallId: "call-1", ...fields }) as StepPartOf<TYPE>;

/** A finished tool call with the given metadata, in the shape a tool returns. */
const doneTool = <TYPE extends StepPart["type"]>(
  type: TYPE,
  metadata: unknown,
  extra: Record<string, unknown> = {}
): StepPartOf<TYPE> =>
  part({
    type,
    state: "output-available",
    input: {},
    output: { code: "ok", output: "", metadata },
    ...extra,
  });

describe(pendingSummary, () => {
  test("should say a held call is waiting on the user", () => {
    expect(
      pendingSummary(
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
      pendingSummary(
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
      pendingSummary(part({ type: "tool-bash", state: "input-available" }))
    ).toBeUndefined();
  });
});

describe(finishedOutput, () => {
  test("should say nothing for a tool whose output is an error", () => {
    expect(
      finishedOutput(
        part({
          type: "tool-bash",
          state: "output-available",
          output: { code: "error", output: "no" },
        })
      )
    ).toBeUndefined();
  });
});

describe("read-file", () => {
  const readFile = (metadata: unknown) =>
    readFileSummary(doneTool("tool-read-file", metadata));

  test("should say nothing for a turn persisted before metadata existed", () => {
    expect(
      readFileSummary(
        part({
          type: "tool-read-file",
          state: "output-available",
          output: { code: "ok", output: "contents" },
        })
      )
    ).toBeUndefined();
  });

  test("should count the lines of a file read whole", () => {
    expect(readFile({ type: "file", truncated: false, totalLines: 240 })).toBe(
      "240 lines"
    );
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
    const summary = loadSkillSummary(
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
    const summary = loadSkillSummary(
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
    grepSummary(doneTool("tool-grep", metadata, { input }));

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
    globSummary(doneTool("tool-glob", metadata));

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
    shellSummary(doneTool("tool-bash", metadata));

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

  test("should report the signal that killed the command", () => {
    expect(bash({ signal: "SIGKILL" })).toBe("killed by SIGKILL");
  });

  test("should mark a truncated output", () => {
    expect(bash({ exitCode: 1, truncated: true })).toBe(
      "exit 1 · output truncated"
    );
  });

  test("should say only that the output was truncated", () => {
    expect(bash({ exitCode: 0, truncated: true })).toBe("output truncated");
  });
});

describe("powershell", () => {
  const powershell = (metadata: unknown) =>
    shellSummary(doneTool("tool-powershell", metadata));

  test("should report a nonzero exit", () => {
    expect(powershell({ exitCode: 2 })).toBe("exit 2");
  });

  test("should report a timeout", () => {
    expect(powershell({ timeout: true })).toBe("timed out");
  });

  test("should say nothing for a command that succeeded", () => {
    expect(powershell({ exitCode: 0 })).toBeUndefined();
  });
});

describe("web-fetch", () => {
  test("should prefer the page title", () => {
    expect(
      webFetchSummary(
        doneTool("tool-web-fetch", { title: "Example", url: "https://e.com" })
      )
    ).toBe("Example");
  });

  test("should fall back to the url and mark a truncated body", () => {
    expect(
      webFetchSummary(
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
      summaryText(
        editFileSummary(
          doneTool("tool-edit-file", {
            replacements: 1,
            linesAdded: 12,
            linesRemoved: 4,
          })
        )
      )
    ).toBe("+12 −4");
  });

  test("should note how many blocks one call replaced", () => {
    expect(
      summaryText(
        editFileSummary(
          doneTool("tool-edit-file", {
            replacements: 2,
            linesAdded: 3,
            linesRemoved: 1,
          })
        )
      )
    ).toBe("+3 −1 · 2 blocks");
  });
});

describe("write-file", () => {
  test("should distinguish a created file from an updated one", () => {
    expect(
      writeFileSummary(
        doneTool("tool-write-file", { created: true, lines: 42 })
      )
    ).toBe("created · 42 lines");
    expect(
      writeFileSummary(
        doneTool("tool-write-file", { created: false, lines: 7 })
      )
    ).toBe("updated · 7 lines");
  });

  test("should omit the line count for an empty file", () => {
    expect(
      writeFileSummary(doneTool("tool-write-file", { created: true, lines: 0 }))
    ).toBe("created");
  });
});

describe("delete-file", () => {
  test("should name what was deleted", () => {
    expect(
      deleteFileSummary(doneTool("tool-delete-file", { kind: "directory" }))
    ).toBe("directory deleted");
    expect(
      deleteFileSummary(doneTool("tool-delete-file", { kind: "file" }))
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
    expect(taskSummary(task({ state: "input-available" }))).toBe("explore");
  });

  test("should name the subagent while it is only reporting part-way", () => {
    // The same call in its next state: the first report is the session it
    // started, not an answer, and the row still has to say who is at work.
    expect(
      taskSummary(
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
      taskSummary(
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
      taskSummary(
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

describe("questionnaire", () => {
  test("should say a held questionnaire is waiting for answers", () => {
    expect(
      questionnaireSummary(
        part({
          type: "tool-questionnaire",
          state: "approval-requested",
          input: { questions: [] },
          approval: { id: "ap-1", createdAt: 1000 },
        })
      )
    ).toBe("awaiting answers");
  });

  test("should say the answers were submitted before the stream catches up", () => {
    expect(
      questionnaireSummary(
        part({
          type: "tool-questionnaire",
          state: "approval-responded",
          input: { questions: [] },
          approval: { id: "ap-1", approved: true, createdAt: 1000 },
        })
      )
    ).toBe("answers submitted");
  });

  test("should say how many questions were answered", () => {
    expect(
      questionnaireSummary(
        doneTool("tool-questionnaire", {
          status: "submitted",
          total: 3,
          answered: 2,
          answers: {},
        })
      )
    ).toBe("2/3 answered");
  });

  test("should say a questionnaire was declined", () => {
    expect(
      questionnaireSummary(
        part({
          type: "tool-questionnaire",
          state: "output-denied",
          input: { questions: [] },
          approval: { id: "ap-1", approved: false, createdAt: 1000 },
        })
      )
    ).toBe("declined");
  });
});
