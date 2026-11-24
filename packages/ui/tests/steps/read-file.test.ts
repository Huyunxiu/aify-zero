import { describe, expect, test } from "vitest";

import { outputLanguageOf } from "../../src/blocks/steps/read-file";
import type { StepPartOf } from "../../src/blocks/steps/types";

/**
 * Builds a read part from the fields a case cares about, cast through the real
 * union rather than restating it: a test that re-declared the shape would agree
 * with itself.
 */
const part = (fields: Record<string, unknown>): StepPartOf<"tool-read-file"> =>
  ({
    rawInput: "",
    toolCallId: "call-1",
    ...fields,
  }) as StepPartOf<"tool-read-file">;

/** A finished read whose output carries `metadata`, in the shape the tool returns. */
const finished = (metadata: unknown): StepPartOf<"tool-read-file"> =>
  part({
    type: "tool-read-file",
    state: "output-available",
    input: { path: "src/app.tsx" },
    output: { code: "ok", output: "", metadata },
  });

describe(outputLanguageOf, () => {
  test("should give a language only to the content of a file that was read", () => {
    // A read that answers with the file's content gets that file's language.
    expect(
      outputLanguageOf(finished({ type: "file", filepath: "src/app.tsx" }))
    ).toBe("tsx");

    // It answers four other ways, and each describes what happened instead of
    // handing back content.
    expect(
      outputLanguageOf(finished({ type: "directory", filepath: "src" }))
    ).toBe("text");
    expect(
      outputLanguageOf(
        finished({
          type: "attachments",
          filepath: "logo.png",
          mime: "image/png",
        })
      )
    ).toBe("text");
    expect(
      outputLanguageOf(
        finished({
          type: "binary-file",
          filepath: "blob.bin",
          mime: "application/octet-stream",
        })
      )
    ).toBe("text");
    expect(
      outputLanguageOf(finished({ type: "miss", filepath: "missing.ts" }))
    ).toBe("text");
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
