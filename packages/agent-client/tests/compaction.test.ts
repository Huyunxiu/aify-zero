import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import { AgentTurnAssembler } from "../src/agent-turn-assembler";
import type {
  AgentCompactionStep,
  AgentStreamEvent,
  CompactionRecord,
} from "../src/types";

const record: CompactionRecord = {
  version: 1,
  id: "compaction-1",
  trigger: "pressure",
  summary: "summary text",
  tokensBefore: 1000,
  tokensAfter: 100,
  shadowedTokens: 900,
  shadowedTurns: 1,
  shadowedSteps: 2,
  model: "test-model",
  createdAt: 10,
};

const usage = {
  inputTokens: 0,
  inputTokenDetails: {
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 0,
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
  totalTokens: 0,
};

const push = (
  assembler: AgentTurnAssembler<ToolSet>,
  event: AgentStreamEvent<ToolSet>
) => assembler.push(event);

describe("AgentTurnAssembler compaction markers", () => {
  test("opens the part on start and commits the record on end", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });

    await push(assembler, {
      type: "turn.start",
      id: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await push(assembler, {
      type: "step.start",
      id: "step-1",
      turnId: "turn-1",
      stepType: "assistant",
      model: "test-model",
      createdAt: 2,
    });
    await push(assembler, {
      type: "step.start",
      id: "step-2",
      turnId: "turn-1",
      stepType: "compaction",
      model: "test-model",
      createdAt: 3,
    });
    await push(assembler, {
      type: "compaction.start",
      id: "compaction-1",
      turnId: "turn-1",
      stepId: "step-2",
      trigger: "pressure",
      createdAt: 4,
    });

    const [turn] = assembler.turns;
    expect(turn?.type).toBe("assistant");
    const [, startedStep] = (turn?.content ?? []) as AgentCompactionStep[];
    expect(startedStep?.content).toStrictEqual([
      {
        type: "compaction",
        id: "compaction-1",
        state: "streaming",
        createdAt: 4,
      },
    ]);

    await push(assembler, {
      type: "compaction.end",
      id: "compaction-1",
      turnId: "turn-1",
      stepId: "step-2",
      record,
      createdAt: 5,
    });
    await push(assembler, {
      type: "step.finish",
      id: "step-2",
      turnId: "turn-1",
      status: "done",
      usage,
      finishReason: "stop",
      rawFinishReason: "stop",
      providerMetadata: undefined,
      createdAt: 6,
    });

    const [, step] = (turn?.content ?? []) as AgentCompactionStep[];
    if (!step) {
      throw new Error("expected a compaction step");
    }
    expect(step.type).toBe("compaction");
    expect(step.content[0]).toStrictEqual({
      type: "compaction",
      id: "compaction-1",
      state: "done",
      createdAt: 4,
      completedAt: 5,
      record,
    });
    expect(step.status).toBe("done");
  });

  test("takes back an uncommitted part on error", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    await push(assembler, {
      type: "turn.start",
      id: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await push(assembler, {
      type: "step.start",
      id: "step-1",
      turnId: "turn-1",
      stepType: "assistant",
      model: "test-model",
      createdAt: 2,
    });
    await push(assembler, {
      type: "step.start",
      id: "step-2",
      turnId: "turn-1",
      stepType: "compaction",
      model: "test-model",
      createdAt: 3,
    });
    await push(assembler, {
      type: "compaction.start",
      id: "compaction-1",
      turnId: "turn-1",
      stepId: "step-2",
      trigger: "pressure",
      createdAt: 4,
    });
    await push(assembler, {
      type: "compaction.error",
      id: "compaction-1",
      error: "boom",
      createdAt: 5,
    });

    const [turn] = assembler.turns;
    expect(turn?.content).toHaveLength(1);
    expect(turn?.content[0]?.type).toBe("assistant");
  });

  test("settle takes back a compaction that never finished", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    await push(assembler, {
      type: "turn.start",
      id: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await push(assembler, {
      type: "step.start",
      id: "step-1",
      turnId: "turn-1",
      stepType: "assistant",
      model: "test-model",
      createdAt: 2,
    });
    await push(assembler, {
      type: "step.start",
      id: "step-2",
      turnId: "turn-1",
      stepType: "compaction",
      model: "test-model",
      createdAt: 3,
    });
    await push(assembler, {
      type: "compaction.start",
      id: "compaction-1",
      turnId: "turn-1",
      stepId: "step-2",
      trigger: "pressure",
      createdAt: 4,
    });

    assembler.settle("aborted");

    const [turn] = assembler.turns;
    expect(turn?.content).toHaveLength(1);
    expect(turn?.content[0]?.type).toBe("assistant");
  });

  test("ignores an end event that arrives before its step", async () => {
    const assembler = new AgentTurnAssembler<ToolSet>({ turns: [] });
    await push(assembler, {
      type: "turn.start",
      id: "turn-1",
      turnType: "assistant",
      createdAt: 1,
    });
    await push(assembler, {
      type: "compaction.end",
      id: "compaction-1",
      turnId: "turn-1",
      stepId: "missing",
      record,
      createdAt: 2,
    });

    expect(assembler.turns[0]?.content).toHaveLength(0);
  });
});
