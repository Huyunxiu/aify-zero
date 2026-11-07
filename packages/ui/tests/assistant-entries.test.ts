import type { AgentToolSet } from "@workspace/agent";
import type {
  AgentAssistantStep,
  AgentAssistantTurn,
  AgentCompactionStep,
  AgentAssistantPart,
  AgentSteeringStep,
} from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { splitAssistantMessageSteps } from "../src/elements/assistant-entries";

const textPart = (text: string, createdAt = 1) => ({
  type: "text" as const,
  text,
  createdAt,
  state: "done" as const,
});

const assistantStep = (
  id: string,
  text: string,
  createdAt = 1
): AgentAssistantStep<AgentToolSet> =>
  assistantStepWith(id, [textPart(text, createdAt)], createdAt);

const assistantStepWith = (
  id: string,
  content: AgentAssistantStep<AgentToolSet>["content"],
  createdAt = 1
): AgentAssistantStep<AgentToolSet> => ({
  id,
  type: "assistant",
  model: "test-model",
  createdAt,
  status: "done",
  content,
});

/** 一个已经排队的工具调用：它不承担答案，但会占住链的尾部。 */
const toolPart = (): AgentAssistantPart<AgentToolSet> =>
  ({
    type: "tool-bash",
    toolCallId: "call-1",
    rawInput: "",
    state: "input-available",
    input: {},
  }) as AgentAssistantPart<AgentToolSet>;

const steeringStep = (
  id: string,
  text: string,
  createdAt = 1
): AgentSteeringStep => ({
  id,
  type: "steering",
  createdAt,
  completedAt: createdAt,
  status: "done",
  content: [textPart(text, createdAt)],
});

const assistantTurn = (
  content: (
    | AgentAssistantStep<AgentToolSet>
    | AgentCompactionStep
    | AgentSteeringStep
  )[]
): AgentAssistantTurn<AgentToolSet> => ({
  id: "turn-1",
  type: "assistant",
  createdAt: 1,
  status: "done",
  content,
});

describe(splitAssistantMessageSteps, () => {
  test("keeps a steering step in the chain and leaves the final text as the answer", () => {
    const split = splitAssistantMessageSteps(
      assistantTurn([
        assistantStep("s1", "before"),
        steeringStep("steer-1", "Try the other path."),
        assistantStep("s2", "after"),
      ])
    );

    expect(
      split.entries.map((entry) =>
        entry.kind === "steering" ? `steer:${entry.step.id}` : entry.part.type
      )
    ).toStrictEqual(["text", "steer:steer-1"]);
    expect(split.answerPart).toMatchObject({ type: "text", text: "after" });
    // steering 不参与工具统计。
    expect(split.parts.map((row) => row.part.type)).toStrictEqual(["text"]);
  });

  test("keeps the last text as the answer when the turn ends with steering", () => {
    const split = splitAssistantMessageSteps(
      assistantTurn([
        assistantStep("s1", "before"),
        steeringStep("steer-1", "And then?"),
      ])
    );

    expect(split.answerPart).toMatchObject({ type: "text", text: "before" });
    expect(split.entries.map((entry) => entry.kind)).toStrictEqual([
      "steering",
    ]);
  });

  test("takes the text as the answer when a tool call follows it", () => {
    const split = splitAssistantMessageSteps(
      assistantTurn([assistantStepWith("s1", [textPart("answer"), toolPart()])])
    );

    expect(split.answerPart).toMatchObject({ type: "text", text: "answer" });
    expect(split.entries.map((entry) => entry.kind)).toStrictEqual(["part"]);
    expect(split.parts.map((row) => row.part.type)).toStrictEqual([
      "tool-bash",
    ]);
  });

  test("renders a turn that only holds steering as steps", () => {
    const split = splitAssistantMessageSteps(
      assistantTurn([steeringStep("steer-1", "Go left.")])
    );

    expect(split.entries).toHaveLength(1);
    expect(split.answerPart).toBeUndefined();
    expect(split.parts).toStrictEqual([]);
  });
});
