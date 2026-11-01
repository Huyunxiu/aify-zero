import type { AgentToolSet } from "@workspace/agent";
import type {
  AgentAssistantStep,
  AgentAssistantTurn,
  AgentSteeringStep,
  AgentTurn,
  AgentUserTurn,
} from "@workspace/agent-client";

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
  options: { createdAt?: number; text?: string } = {}
): AgentAssistantStep<AgentToolSet> => {
  const createdAt = options.createdAt ?? 1;
  return {
    id,
    type: "assistant",
    createdAt,
    status: "done",
    model: "test-model",
    content: options.text ? [textPart(options.text, createdAt)] : [],
  };
};

export const assistantTurn = (
  id: string,
  content: (AgentAssistantStep<AgentToolSet> | AgentSteeringStep)[]
): AgentAssistantTurn<AgentToolSet> => ({
  id,
  type: "assistant",
  createdAt: 1,
  status: "done",
  content,
});

export const asTurns = (
  ...turns: AgentTurn<AgentToolSet>[]
): AgentTurn<AgentToolSet>[] => turns;
