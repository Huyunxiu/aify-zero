import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import { AgentTurnBuilder } from "../src/agent-turn-builder.js";
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

describe("AgentTurnBuilder#getStep", () => {
  test("returns the step an event created", async () => {
    const builder = new AgentTurnBuilder<ToolSet>({ turns: [] });

    await builder.push({
      type: "turn.start",
      id: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await builder.push({
      type: "step.start",
      id: "step-1",
      turnId: "turn-1",
      stepType: "assistant",
      model: "test-model",
      createdAt: 2,
    });

    expect(builder.getStep("step-1")?.id).toBe("step-1");
  });

  test("returns undefined for an unknown step", () => {
    const builder = new AgentTurnBuilder<ToolSet>({ turns: [] });

    expect(builder.getStep("missing")).toBeUndefined();
  });
});

describe("AgentTurnBuilder#settle", () => {
  test("only settles turns and steps that are still streaming", async () => {
    const builder = new AgentTurnBuilder<ToolSet>({ turns: [doneTurn] });

    await builder.push({
      type: "turn.start",
      id: "new-turn",
      turnType: "assistant",
      createdAt: 2,
    });
    await builder.push({
      type: "step.start",
      id: "new-step",
      turnId: "new-turn",
      stepType: "assistant",
      model: "test-model",
      createdAt: 3,
    });

    builder.settle("aborted");

    expect(doneTurn.status).toBe("done");
    expect(assistantStep.status).toBe("done");
    expect(builder.getStep("new-step")?.status).toBe("aborted");
    expect(builder.turns.find((turn) => turn.id === "new-turn")?.status).toBe(
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

describe("AgentTurnBuilder#turn.steer", () => {
  test("appends a steering step to the running assistant turn", async () => {
    const builder = new AgentTurnBuilder<ToolSet>({ turns: [] });

    await builder.push({
      type: "turn.start",
      id: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await builder.push({
      type: "turn.steer",
      turnId: "turn-1",
      step: steeringStep,
      createdAt: 2,
    });

    const turn = builder.turns.find((candidate) => candidate.id === "turn-1");

    expect(turn?.content.map((step) => step.id)).toStrictEqual(["steer-1"]);
    expect(builder.getStep("steer-1")?.type).toBe("steering");
    expect(builder.changedTurns.map((changed) => changed.id)).toContain(
      "turn-1"
    );
  });

  test("does not append the same step twice when the stream is replayed", async () => {
    const builder = new AgentTurnBuilder<ToolSet>({ turns: [] });

    await builder.push({
      type: "turn.start",
      id: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await builder.push({
      type: "turn.steer",
      turnId: "turn-1",
      step: steeringStep,
      createdAt: 2,
    });
    await builder.push({
      type: "turn.steer",
      turnId: "turn-1",
      step: steeringStep,
      createdAt: 3,
    });

    const turn = builder.turns.find((candidate) => candidate.id === "turn-1");

    expect(turn?.content).toHaveLength(1);
  });

  test("ignores a steering step for an unknown turn", async () => {
    const builder = new AgentTurnBuilder<ToolSet>({ turns: [] });

    await builder.push({
      type: "turn.steer",
      turnId: "missing",
      step: steeringStep,
      createdAt: 2,
    });

    expect(builder.getStep("steer-1")).toBeUndefined();
  });
});
