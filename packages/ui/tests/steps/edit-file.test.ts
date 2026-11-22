import { describe, expect, test } from "vitest";

import { editDiffRows, editDiffText } from "../../src/elements/steps/edit-file";
import type { StepPartOf } from "../../src/elements/steps/types";

/**
 * Builds an edit part from the fields a case cares about, cast through the real
 * union rather than restating it: a test that re-declared the shape would agree
 * with itself.
 */
const part = (fields: Record<string, unknown>): StepPartOf<"tool-edit-file"> =>
  ({
    rawInput: "",
    toolCallId: "call-1",
    ...fields,
  }) as StepPartOf<"tool-edit-file">;

/** A finished edit whose output carries the diff the tool rendered. */
const finished = (diff: string): StepPartOf<"tool-edit-file"> =>
  part({
    type: "tool-edit-file",
    state: "output-available",
    input: { path: "src/app.ts" },
    output: { code: "ok", output: "", metadata: { diff } },
  });

describe(editDiffRows, () => {
  test("should read the diff the tool reported, line by line", () => {
    expect(
      editDiffRows(finished("+ 12 const a = 1;\n- 9 const b = 2;"))
    ).toStrictEqual([
      { sign: "+", text: " 12 const a = 1;" },
      { sign: "-", text: " 9 const b = 2;" },
    ]);
  });

  test("should preview the edit from its input while the call streams", () => {
    // No result yet: the rows come from the replacement the call asked for.
    expect(
      editDiffRows(
        part({
          type: "tool-edit-file",
          state: "input-streaming",
          input: {
            path: "src/app.ts",
            edits: [{ oldText: "a\nb", newText: "a\nc" }],
          },
        })
      )
    ).toStrictEqual([
      { sign: "-", text: "a" },
      { sign: "-", text: "b" },
      { sign: "+", text: "a" },
      { sign: "+", text: "c" },
    ]);
  });

  test("should skip a replacement that is still arriving", () => {
    // While streaming, `input` is a partial: a block without both sides would
    // draw a diff that is not what the call will do.
    expect(
      editDiffRows(
        part({
          type: "tool-edit-file",
          state: "input-streaming",
          input: { path: "src/app.ts", edits: [{ oldText: "a" }] },
        })
      )
    ).toStrictEqual([]);
  });
});

describe(editDiffText, () => {
  test("should join the rows as the copy button hands them over", () => {
    expect(editDiffText(finished("+ 1 x\n- 2 y"))).toBe("+ 1 x\n- 2 y");
  });
});
