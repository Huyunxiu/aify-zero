import type {
  AgentAssistantStep,
  AgentAssistantTurn,
  AgentCompactionStep,
  AgentCompactionTurn,
  AgentTurn,
  AgentUserTurn,
  CompactionRecord,
} from "@workspace/agent-client";

import type { AgentToolSet } from "../../src/types.js";

export const textPart = (text: string, createdAt = 1) => ({
  type: "text" as const,
  text,
  createdAt,
  state: "done" as const,
});

export const userTurn = (id: string, text: string): AgentUserTurn => ({
  id,
  type: "user",
  createdAt: 1,
  status: "done",
  content: [
    {
      id: `${id}-step`,
      type: "user",
      createdAt: 1,
      status: "done",
      content: [textPart(text)],
    },
  ],
});

export const assistantStep = (
  id: string,
  options: {
    createdAt?: number;
    inputTokens?: number;
    text?: string;
  } = {}
): AgentAssistantStep<AgentToolSet> => {
  const createdAt = options.createdAt ?? 1;
  return {
    id,
    type: "assistant",
    createdAt,
    status: "done",
    model: "test-model",
    content: options.text ? [textPart(options.text, createdAt)] : [],
    ...(options.inputTokens === undefined
      ? {}
      : {
          usage: {
            inputTokens: options.inputTokens,
            inputTokenDetails: {
              noCacheTokens: options.inputTokens,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            outputTokens: 10,
            outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
            totalTokens: options.inputTokens + 10,
          },
        }),
  };
};

export const assistantTurn = (
  id: string,
  content: (AgentAssistantStep<AgentToolSet> | AgentCompactionStep)[]
): AgentAssistantTurn<AgentToolSet> => ({
  id,
  type: "assistant",
  createdAt: 1,
  status: "done",
  content,
});

export const record = (
  overrides: Partial<CompactionRecord> = {}
): CompactionRecord => ({
  version: 1,
  id: overrides.id ?? "compaction-1",
  trigger: overrides.trigger ?? "pressure",
  summary: overrides.summary ?? "A structured summary of the earlier work.",
  tokensBefore: overrides.tokensBefore ?? 1000,
  tokensAfter: overrides.tokensAfter ?? 200,
  shadowedTokens: overrides.shadowedTokens ?? 900,
  shadowedTurns: overrides.shadowedTurns ?? 1,
  shadowedSteps: overrides.shadowedSteps ?? 2,
  model: overrides.model ?? "test-model",
  retainedFromTurnId: overrides.retainedFromTurnId,
  usage: overrides.usage,
  createdAt: overrides.createdAt ?? 1,
});

export const compactionStep = (
  value: CompactionRecord = record(),
  id = "compaction-step"
): AgentCompactionStep => ({
  id,
  type: "compaction",
  createdAt: value.createdAt,
  status: "done",
  model: value.model,
  content: [
    {
      type: "compaction",
      id: value.id,
      state: "done",
      createdAt: value.createdAt,
      record: value,
    },
  ],
});

export const compactionTurn = (
  value: CompactionRecord = record(),
  id = "compaction-turn"
): AgentCompactionTurn => ({
  id,
  type: "compaction",
  createdAt: value.createdAt,
  status: "done",
  content: [compactionStep(value)],
});

export const asTurns = (
  ...turns: AgentTurn<AgentToolSet>[]
): AgentTurn<AgentToolSet>[] => turns;
