import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import { AgentTurnAssembler } from "../src/agent-turn-assembler.js";
import type {
  AgentAssistantStep,
  AgentAssistantTurn,
  AgentSteeringStep,
} from "../src/types.js";

const assistantStep: AgentAssistantStep<ToolSet> = {
  id: "old-step",
  type: "assistant",
  model: "test-model",
  createdAt: 1,
  status: "done",
  content: [],
};

const doneTurn: AgentAssistantTurn<ToolSet> = {
  id: "old-turn",
  type: "assistant",
  createdAt: 1,
  status: "done",
  content: [assistantStep],
};

describe("AgentTurnAssembler#getStep", () => {
  test("returns the step an event created", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });

    await assembler.push({
      type: "turn.start",
      turnId: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await assembler.push({
      type: "step.start",
      stepId: "step-1",
      turnId: "turn-1",
      stepType: "assistant",
      model: "test-model",
      createdAt: 2,
    });

    expect(assembler.getStep("step-1")?.id).toBe("step-1");
  });

  test("returns undefined for an unknown step", () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });

    expect(assembler.getStep("missing")).toBeUndefined();
  });
});

describe("AgentTurnAssembler#settle", () => {
  test("only settles turns and steps that are still streaming", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [doneTurn] });

    await assembler.push({
      type: "turn.start",
      turnId: "new-turn",
      turnType: "assistant",
      createdAt: 2,
    });
    await assembler.push({
      type: "step.start",
      stepId: "new-step",
      turnId: "new-turn",
      stepType: "assistant",
      model: "test-model",
      createdAt: 3,
    });

    assembler.settle("aborted");

    expect(doneTurn.status).toBe("done");
    expect(assistantStep.status).toBe("done");
    expect(assembler.getStep("new-step")?.status).toBe("aborted");
    expect(assembler.turns.find((turn) => turn.id === "new-turn")?.status).toBe(
      "aborted"
    );
  });
});

const steeringStep: AgentSteeringStep = {
  id: "steer-1",
  type: "steering",
  createdAt: 5,
  completedAt: 5,
  status: "done",
  content: [{ type: "text", text: "Try the other path.", createdAt: 5 }],
};

describe("AgentTurnAssembler#turn.steer", () => {
  test("appends a steering step to the running assistant turn", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });

    await assembler.push({
      type: "turn.start",
      turnId: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await assembler.push({
      type: "turn.steer",
      turnId: "turn-1",
      step: steeringStep,
      createdAt: 2,
    });

    const turn = assembler.turns.find((candidate) => candidate.id === "turn-1");

    expect(turn?.content.map((step) => step.id)).toStrictEqual(["steer-1"]);
    expect(assembler.getStep("steer-1")?.type).toBe("steering");
    expect(assembler.changedTurns.map((changed) => changed.id)).toContain(
      "turn-1"
    );
  });

  test("does not append the same step twice when the stream is replayed", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });

    await assembler.push({
      type: "turn.start",
      turnId: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await assembler.push({
      type: "turn.steer",
      turnId: "turn-1",
      step: steeringStep,
      createdAt: 2,
    });
    await assembler.push({
      type: "turn.steer",
      turnId: "turn-1",
      step: steeringStep,
      createdAt: 3,
    });

    const turn = assembler.turns.find((candidate) => candidate.id === "turn-1");

    expect(turn?.content).toHaveLength(1);
  });

  test("ignores a steering step for an unknown turn", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });

    await assembler.push({
      type: "turn.steer",
      turnId: "missing",
      step: steeringStep,
      createdAt: 2,
    });

    expect(assembler.getStep("steer-1")).toBeUndefined();
  });
});

const startTurnAndStep = async (assembler: AgentTurnAssembler<ToolSet>) => {
  await assembler.push({
    type: "turn.start",
    turnId: "turn-1",
    turnType: "assistant",
    createdAt: 1,
  });
  await assembler.push({
    type: "step.start",
    stepId: "step-1",
    turnId: "turn-1",
    stepType: "assistant",
    model: "test-model",
    createdAt: 2,
  });
};

describe("AgentTurnAssembler#changedSteps", () => {
  test("tracks the steps a stream changes until they are persisted", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    await startTurnAndStep(assembler);

    await assembler.push({
      type: "text.start",
      id: "part-1",
      turnId: "turn-1",
      stepId: "step-1",
      createdAt: 3,
    });

    expect(assembler.changedSteps).toStrictEqual([
      { turnId: "turn-1", stepId: "step-1" },
    ]);

    assembler.markStepPersisted("step-1");
    expect(assembler.changedSteps).toStrictEqual([]);

    // 落库之后又被改动，要重新记上：回合结束的兜底写入不能漏掉它。
    await assembler.push({
      type: "text.delta",
      id: "part-1",
      turnId: "turn-1",
      stepId: "step-1",
      text: "more",
      createdAt: 4,
    });

    expect(assembler.changedSteps).toStrictEqual([
      { turnId: "turn-1", stepId: "step-1" },
    ]);
  });

  test("ignores a step the assembler does not hold", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });

    await assembler.push({
      type: "text.delta",
      id: "part-1",
      turnId: "missing-turn",
      stepId: "missing-step",
      text: "ignored",
      createdAt: 2,
    });

    expect(assembler.changedSteps).toStrictEqual([]);
  });
});
