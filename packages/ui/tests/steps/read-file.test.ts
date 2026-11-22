import type { AgentToolPart, AgentToolSet } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { outputLanguageOf } from "../../src/elements/steps/file-read";

/**
 * Builds a part from the fields a case cares about, cast through the real union
 * rather than restating it — a test that re-declared the shape would agree with
 * itself. `tool-step.test.ts` uses the same fixture.
 */
const part = (fields: Record<string, unknown>): AgentToolPart<AgentToolSet> =>
  ({
    rawInput: "",
    toolCallId: "call-1",
    ...fields,
  }) as AgentToolPart<AgentToolSet>;

/** A finished call whose output carries `metadata`, in the shape a tool returns. */
const finished = (
  type: string,
  path: string,
  metadata: unknown
): AgentToolPart<AgentToolSet> =>
  part({
    type,
    state: "output-available",
    input: { path },
    output: { code: "ok", output: "", metadata },
  });

describe(outputLanguageOf, () => {
  test("should give a language only to the content of a file that was read", () => {
    const cases: [
      type: string,
      path: string,
      metadata: unknown,
      lang: string,
    ][] = [
      // A read that answers with the file's content.
      [
        "tool-read-file",
        "src/app.tsx",
        { type: "file", filepath: "src/app.tsx" },
        "tsx",
      ],
      // A read answers four other ways, and each describes what happened
      // instead of handing back content.
      ["tool-read-file", "src", { type: "directory", filepath: "src" }, "text"],
      [
        "tool-read-file",
        "logo.png",
        { type: "attachments", filepath: "logo.png", mime: "image/png" },
        "text",
      ],
      [
        "tool-read-file",
        "blob.bin",
        {
          type: "binary-file",
          filepath: "blob.bin",
          mime: "application/octet-stream",
        },
        "text",
      ],
      [
        "tool-read-file",
        "missing.ts",
        { type: "miss", filepath: "missing.ts" },
        "text",
      ],
      // A write answers "Wrote file successfully.", not the file it wrote.
      ["tool-write-file", "src/app.tsx", { filepath: "src/app.tsx" }, "text"],
      ["tool-edit-file", "src/app.tsx", { filepath: "src/app.tsx" }, "text"],
      ["tool-delete-file", "src/app.tsx", { filepath: "src/app.tsx" }, "text"],
      // A skill answers with its own body, which is prose.
      [
        "tool-load-skill",
        "SKILL.md",
        { type: "file", filepath: "SKILL.md" },
        "text",
      ],
    ];

    for (const [type, path, metadata, lang] of cases) {
      expect(outputLanguageOf(finished(type, path, metadata))).toBe(lang);
    }
  });

  test("should answer text for a turn persisted before metadata existed", () => {
    // `read-file` reported only a string in older turns. Nothing in such a part
    // says the answer is a file's content, so it gets no language.
    expect(
      outputLanguageOf(
        part({
          type: "tool-read-file",
          state: "output-available",
          input: { path: "src/app.tsx" },
          output: { code: "ok", output: "export const a = 1;" },
        })
      )
    ).toBe("text");
  });

  test("should answer text for a call that has no result yet", () => {
    expect(
      outputLanguageOf(
        part({
          type: "tool-read-file",
          state: "input-streaming",
          input: { path: "src/app.tsx" },
        })
      )
    ).toBe("text");
  });
});
