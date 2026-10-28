/* oxlint-disable vitest/max-expects */
import type { AgentAssistantStep } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { projectHistory } from "../../src/compaction/project.js";
import type { AgentToolSet } from "../../src/types.js";
import {
  asTurns,
  assistantStep,
  assistantTurn,
  compactionStep,
  compactionTurn,
  record,
  steeringStep,
  userTurn,
} from "./fixtures.js";

const textOf = (message: { content: unknown } | undefined): string => {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content
    .map((part) =>
      part !== null && typeof part === "object" && "text" in part
        ? (() => {
            const { text } = part as { text?: unknown };
            return typeof text === "string" ? text : "";
          })()
        : ""
    )
    .join("");
};

const toolStep: AgentAssistantStep<AgentToolSet> = {
  id: "tool-step",
  type: "assistant",
  createdAt: 1,
  status: "done",
  model: "test-model",
  content: [
    {
      type: "dynamic-tool",
      state: "output-available",
      toolCallId: "call-1",
      toolName: "grep",
      input: { pattern: "needle" },
      output: { code: "ok", output: "found" },
      rawInput: "{}",
    },
  ],
};

describe(projectHistory, () => {
  test("keeps the history when no marker exists", async () => {
    const projected = await projectHistory(
      asTurns(
        userTurn("u1", "hello"),
        assistantTurn("a1", [assistantStep("s1", { text: "hi" })])
      )
    );
    expect(projected.messages).toHaveLength(2);
    expect(projected.checkpoint).toBeUndefined();
    expect(projected.turnAnchors.map((anchor) => anchor.turnId)).toStrictEqual([
      "u1",
      "a1",
    ]);
  });

  test("resets at an inline marker and keeps the steps after it", async () => {
    const marker = record({ createdAt: 10, summary: "earlier work" });
    const projected = await projectHistory(
      asTurns(
        userTurn("u1", "hello"),
        assistantTurn("a1", [
          assistantStep("s1", { text: "before", createdAt: 5 }),
          compactionStep(marker),
          assistantStep("s2", { text: "after", createdAt: 20 }),
        ])
      )
    );

    expect(projected.messages).toHaveLength(2);
    expect(textOf(projected.messages[0])).toContain("<compacted-summary>");
    expect(textOf(projected.messages[0])).toContain("earlier work");
    expect(projected.messages[1]?.role).toBe("assistant");
    expect(projected.checkpoint?.id).toBe(marker.id);
    expect(projected.stepAnchors).toStrictEqual([
      { turnId: "a1", stepId: "s2", stepIndex: 2, messageIndex: 1 },
    ]);
    expect(projected.turnAnchors).toStrictEqual([
      { turnId: "a1", messageIndex: 1 },
    ]);
  });

  test("a compaction turn drops everything before it", async () => {
    const marker = record({ trigger: "manual", createdAt: 30 });
    const projected = await projectHistory(
      asTurns(
        userTurn("u1", "old"),
        assistantTurn("a1", [assistantStep("s1", { text: "old reply" })]),
        compactionTurn(marker),
        userTurn("u2", "new request")
      )
    );

    expect(projected.messages).toHaveLength(2);
    expect(projected.messages[0]?.role).toBe("user");
    expect(textOf(projected.messages[0])).toContain("<compacted-summary>");
    expect(textOf(projected.messages[1])).toContain("new request");
    expect(projected.lastUserTurn?.turnId).toBe("u2");
  });

  test("a linear manual marker keeps the turn named by its cut", async () => {
    const marker = record({
      retainedFromTurnId: "u2",
      summary: "summary of the old work",
      trigger: "manual",
      createdAt: 30,
    });
    const projected = await projectHistory(
      asTurns(
        userTurn("u1", "old"),
        assistantTurn("a1", [assistantStep("s1", { text: "old reply" })]),
        userTurn("u2", "new request"),
        compactionTurn(marker)
      )
    );

    expect(projected.messages).toHaveLength(2);
    expect(textOf(projected.messages[0])).toContain("<compacted-summary>");
    expect(textOf(projected.messages[0])).toContain("summary of the old work");
    expect(textOf(projected.messages[1])).toContain("new request");
    expect(projected.lastUserTurn?.turnId).toBe("u2");
    expect(projected.turnAnchors).toStrictEqual([
      { turnId: "u2", messageIndex: 1 },
    ]);
  });

  test("an older linear marker inside the retained tail is ignored", async () => {
    const first = record({
      id: "first",
      retainedFromTurnId: "u2",
      summary: "first summary",
      trigger: "manual",
      createdAt: 10,
    });
    const second = record({
      id: "second",
      retainedFromTurnId: "a2",
      summary: "second summary",
      trigger: "manual",
      createdAt: 20,
    });
    const projected = await projectHistory(
      asTurns(
        userTurn("u1", "old"),
        assistantTurn("a1", [assistantStep("s1", { text: "old reply" })]),
        userTurn("u2", "older request"),
        assistantTurn("a2", [assistantStep("s2", { text: "kept reply" })]),
        compactionTurn(first, "compaction-turn-1"),
        compactionTurn(second, "compaction-turn-2")
      )
    );

    expect(projected.messages).toHaveLength(2);
    expect(textOf(projected.messages[0])).toContain("second summary");
    expect(textOf(projected.messages[0])).not.toContain("first summary");
    expect(textOf(projected.messages[1])).toContain("kept reply");
  });

  test("the last marker wins", async () => {
    const first = record({
      id: "first",
      createdAt: 10,
      summary: "first summary",
    });
    const second = record({
      id: "second",
      createdAt: 20,
      summary: "second summary",
    });
    const projected = await projectHistory(
      asTurns(
        userTurn("u1", "hello"),
        assistantTurn("a1", [
          assistantStep("s1", { text: "before" }),
          compactionStep(first),
          assistantStep("s2", { text: "middle" }),
        ]),
        compactionTurn(second)
      )
    );

    expect(projected.messages).toHaveLength(1);
    expect(textOf(projected.messages[0])).toContain("second summary");
    expect(textOf(projected.messages[0])).not.toContain("first summary");
  });

  test("usage before a marker is ignored, usage after it is not", async () => {
    const marker = record({ createdAt: 20 });
    const projected = await projectHistory(
      asTurns(
        assistantTurn("a1", [
          assistantStep("s1", { createdAt: 10, inputTokens: 100, text: "old" }),
          compactionStep(marker),
          assistantStep("s2", { createdAt: 30, inputTokens: 200, text: "new" }),
        ])
      )
    );

    expect(projected.usageAnchor).toStrictEqual({
      messageIndex: 1,
      inputTokens: 200,
    });
  });

  test("keeps tool calls paired with their results", async () => {
    const projected = await projectHistory(
      asTurns(userTurn("u1", "search"), assistantTurn("a1", [toolStep]))
    );
    expect(projected.messages.map((message) => message.role)).toStrictEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  test("interleaves a steering step as a user message without starting a new turn", async () => {
    const projected = await projectHistory(
      asTurns(
        userTurn("u1", "start"),
        assistantTurn("a1", [
          assistantStep("s1", { text: "working", createdAt: 2 }),
          steeringStep("steer-1", "go left", 3),
          assistantStep("s2", { text: "done", createdAt: 4 }),
        ])
      )
    );

    expect(projected.messages.map((message) => message.role)).toStrictEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(textOf(projected.messages[2])).toBe("go left");
    // steering 不是新的 turn 边界：turn 锚点仍然只有 u1 和 a1。
    expect(projected.turnAnchors).toStrictEqual([
      { turnId: "u1", messageIndex: 0 },
      { turnId: "a1", messageIndex: 1 },
    ]);
    expect(projected.lastUserTurn).toStrictEqual({
      turnId: "u1",
      messageIndex: 0,
    });
    // step 锚点只标 assistant step。
    expect(projected.stepAnchors.map((anchor) => anchor.stepId)).toStrictEqual([
      "s1",
      "s2",
    ]);
  });

  test("a step with no record is ignored", async () => {
    const projected = await projectHistory(
      asTurns(
        userTurn("u1", "hello"),
        assistantTurn("a1", [
          assistantStep("s1", { text: "before" }),
          {
            id: "broken",
            type: "compaction",
            createdAt: 10,
            status: "done",
            model: "test-model",
            content: [],
          },
        ])
      )
    );
    expect(projected.messages).toHaveLength(2);
    expect(projected.checkpoint).toBeUndefined();
  });
});
