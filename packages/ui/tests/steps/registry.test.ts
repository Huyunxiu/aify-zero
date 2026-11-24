import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { FallbackToolStep } from "../../src/blocks/steps/fallback-tool";
import { NoteStep } from "../../src/blocks/steps/note";
import { stepViews, viewFor } from "../../src/blocks/steps/registry";
import type { StepPart } from "../../src/blocks/steps/types";

/**
 * Builds a part from the fields a case cares about, cast through the real union
 * rather than restating it: a test that re-declared the shape would agree with
 * itself.
 */
const part = (fields: Record<string, unknown>): StepPart =>
  ({
    rawInput: "",
    toolCallId: "call-1",
    ...fields,
  }) as StepPart;

/** What a view draws, as markup, through the same lookup the transcript uses. */
const draw = (value: StepPart): string =>
  renderToStaticMarkup(
    createElement(viewFor(value), { part: value, status: "complete" })
  );

describe("the table of part views", () => {
  test("should hold a view for every part it names", () => {
    const missing = Object.entries(stepViews)
      .filter(([, view]) => typeof view !== "function")
      .map(([type]) => type);

    expect(missing).toStrictEqual([]);
  });
});

describe("the view a part is drawn with", () => {
  test("should draw a part with the view its type names", () => {
    expect(viewFor(part({ type: "text", text: "hi" }))).toBe(NoteStep);
  });

  test("should draw a call the table cannot name", () => {
    // A transcript holds calls this package has never heard of: a host tool such
    // as `tool-linear__whoami`, and a tool another version had such as
    // `tool-timer-set`. Both are still calls, and both used to read as one.
    const unnamed = [
      "tool-linear__whoami",
      "tool-timer-set",
      "tool-server-filesystem__list_issues",
    ];
    const misdrawn = unnamed.filter(
      (type) =>
        viewFor(
          part({
            type,
            state: "output-available",
            input: {},
            output: { code: "ok", output: "ok" },
          })
        ) !== FallbackToolStep
    );

    expect(misdrawn).toStrictEqual([]);
  });

  test("should draw a host call with the names it arrived with", () => {
    expect(
      draw(
        part({
          type: "tool-linear__whoami",
          state: "output-available",
          input: {},
          output: { code: "ok", output: "ok" },
        })
      )
    ).toContain("linear · whoami");
  });

  test("should draw nothing for a part the table cannot name that is not a call", () => {
    expect(draw(part({ type: "file", url: "file:///tmp/a.png" }))).toBe("");
  });
});
