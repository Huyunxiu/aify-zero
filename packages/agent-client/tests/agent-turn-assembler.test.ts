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
      id: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await assembler.push({
      type: "step.start",
      id: "step-1",
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
      id: "new-turn",
      turnType: "assistant",
      createdAt: 2,
    });
    await assembler.push({
      type: "step.start",
      id: "new-step",
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
      id: "turn-1",
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
      id: "turn-1",
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
