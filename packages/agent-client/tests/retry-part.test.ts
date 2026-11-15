import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import { AgentTurnAssembler } from "../src/agent-turn-assembler";
import type { AgentAssistantStep, AgentStreamEvent } from "../src/types";

const push = (
  assembler: AgentTurnAssembler<ToolSet>,
  event: AgentStreamEvent<ToolSet>
) => assembler.push(event);

/** 打开一个 assistant turn 和它的一步；重试记录总是落在这之后。 */
const startStep = async (assembler: AgentTurnAssembler<ToolSet>) => {
  await push(assembler, {
    type: "turn.start",
    turnId: "turn-1",
    turnType: "assistant",
    createdAt: 1,
  });
  await push(assembler, {
    type: "step.start",
    stepId: "step-1",
    turnId: "turn-1",
    stepType: "assistant",
    model: "test-model",
    createdAt: 2,
  });
};

describe("AgentTurnAssembler retry records", () => {
  test("puts the record on the step that is retrying", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    await startStep(assembler);

    await push(assembler, {
      type: "step.retry",
      turnId: "turn-1",
      stepId: "step-1",
      index: 1,
      maxRetries: 5,
      reason: "429 Too Many Requests",
      createdAt: 3,
    });

    const [turn] = assembler.turns;
    const [step] = (turn?.content ?? []) as AgentAssistantStep<ToolSet>[];

    expect(step?.content).toStrictEqual([
      {
        type: "retry",
        index: 1,
        maxRetries: 5,
        reason: "429 Too Many Requests",
        createdAt: 3,
      },
    ]);
  });

  test("keeps the record next to what the step streams after the wait", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    await startStep(assembler);

    await push(assembler, {
      type: "step.retry",
      turnId: "turn-1",
      stepId: "step-1",
      index: 2,
      maxRetries: 5,
      reason: "503 Service Unavailable",
      createdAt: 3,
    });
    await push(assembler, {
      type: "text.start",
      id: "text-1",
      turnId: "turn-1",
      stepId: "step-1",
      createdAt: 4,
    });
    await push(assembler, {
      type: "text.delta",
      id: "text-1",
      turnId: "turn-1",
      stepId: "step-1",
      text: "recovered",
      createdAt: 5,
    });

    const [turn] = assembler.turns;
    const [step] = (turn?.content ?? []) as AgentAssistantStep<ToolSet>[];

    expect(step?.content.map((part) => part.type)).toStrictEqual([
      "retry",
      "text",
    ]);
  });

  test("drops a record that has no step to hold it", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    await push(assembler, {
      type: "turn.start",
      turnId: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });

    await push(assembler, {
      type: "step.retry",
      turnId: "turn-1",
      stepId: "missing-step",
      index: 1,
      maxRetries: 5,
      reason: "429 Too Many Requests",
      createdAt: 2,
    });

    expect(assembler.turns[0]?.content).toStrictEqual([]);
  });
});

describe("AgentTurnAssembler settleStep", () => {
  test("closes only the step it was given", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    await push(assembler, {
      type: "turn.start",
      turnId: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await push(assembler, {
      type: "step.start",
      stepId: "step-1",
      turnId: "turn-1",
      stepType: "assistant",
      model: "test-model",
      createdAt: 2,
    });
    await push(assembler, {
      type: "text.start",
      id: "text-1",
      turnId: "turn-1",
      stepId: "step-1",
      createdAt: 3,
    });
    await push(assembler, {
      type: "step.start",
      stepId: "step-2",
      turnId: "turn-1",
      stepType: "assistant",
      model: "test-model",
      createdAt: 4,
    });
    await push(assembler, {
      type: "text.start",
      id: "text-2",
      turnId: "turn-1",
      stepId: "step-2",
      createdAt: 5,
    });

    assembler.settleStep("turn-1", "step-1");

    const [turn] = assembler.turns;
    const [first, second] = (turn?.content ??
      []) as AgentAssistantStep<ToolSet>[];
    expect({
      firstStatus: first?.status,
      firstText: first?.content[0],
      secondStatus: second?.status,
      secondText: second?.content[0],
    }).toMatchObject({
      firstStatus: "error",
      firstText: { type: "text", state: "done" },
      secondStatus: "streaming",
      secondText: { type: "text", state: "streaming" },
    });
  });
});
