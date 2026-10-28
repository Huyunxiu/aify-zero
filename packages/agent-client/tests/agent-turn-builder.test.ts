import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import { AgentTurnBuilder } from "../src/agent-turn-builder.js";
import type { AgentAssistantStep, AgentAssistantTurn } from "../src/types.js";

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
