import type { AgentTurn } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { hasVisibleText } from "../src/outbox/text.js";
import type { AgentToolSet } from "../src/types.js";

const assistantTurn = (
  steps: {
    type: string;
    content: { type: string; text?: string }[];
  }[]
): AgentTurn<AgentToolSet> =>
  ({
    content: steps.map((step, index) => ({
      createdAt: 1,
      id: `step-${String(index)}`,
      status: "done",
      ...step,
    })),
    createdAt: 1,
    id: "turn-1",
    status: "done",
    type: "assistant",
  }) as unknown as AgentTurn<AgentToolSet>;

describe(hasVisibleText, () => {
  test("accepts a turn with text", () => {
    const turn = assistantTurn([
      { content: [{ text: "done", type: "text" }], type: "assistant" },
    ]);

    expect(hasVisibleText(turn)).toBeTruthy();
  });

  test("rejects a turn that only ran tools", () => {
    const turn = assistantTurn([
      { content: [{ type: "tool-bash" }], type: "assistant" },
    ]);

    expect(hasVisibleText(turn)).toBeFalsy();
  });

  test("rejects text that is only whitespace", () => {
    const turn = assistantTurn([
      { content: [{ text: "  \n\t ", type: "text" }], type: "assistant" },
    ]);

    expect(hasVisibleText(turn)).toBeFalsy();
  });

  test("accepts text after a tool-only step", () => {
    const turn = assistantTurn([
      { content: [{ type: "tool-bash" }], type: "assistant" },
      { content: [{ text: "all green", type: "text" }], type: "assistant" },
    ]);

    expect(hasVisibleText(turn)).toBeTruthy();
  });

  test("ignores steering and compaction steps", () => {
    const turn = assistantTurn([
      { content: [{ text: "steer", type: "text" }], type: "steering" },
      { content: [{ text: "compact", type: "text" }], type: "compaction" },
    ]);

    expect(hasVisibleText(turn)).toBeFalsy();
  });

  test("rejects a missing turn", () => {
    expect(hasVisibleText()).toBeFalsy();
  });
});
