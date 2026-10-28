import type { AgentToolSet } from "@workspace/agent";
import type {
  AgentAssistantStep,
  AgentAssistantTurn,
  AgentCompactionStep,
  AgentPart,
  AgentSteeringStep,
} from "@workspace/agent-client";

import type { StepRow } from "./tool-step";

/** assistant turn 里的一行：普通 part，或一条 steering step。 */
export type AssistantEntry =
  | {
      kind: "part";
      part: AgentPart<AgentToolSet>;
      step: AgentAssistantStep<AgentToolSet> | AgentCompactionStep;
    }
  | { kind: "steering"; step: AgentSteeringStep };

const isPartEntry = (
  entry: AssistantEntry
): entry is Extract<AssistantEntry, { kind: "part" }> => entry.kind === "part";

/**
 * Splits a turn into the steps that led to its answer and the answer itself.
 *
 * Each step's parts are kept paired with the step that holds them: the step is
 * where the timing lives, so a row flattened away from its owner could not say
 * how long it took.
 *
 * A steering step stays an entry of its own. It is a user message in the model
 * history, but in the transcript it is a step inside this assistant turn; the
 * renderer decides how to draw it without turning it into a second turn.
 */
export const splitAssistantMessageSteps = (
  turn: AgentAssistantTurn<AgentToolSet>
) => {
  const entries: AssistantEntry[] = turn.content.flatMap(
    (step): AssistantEntry[] => {
      if (step.type === "steering") {
        return [{ kind: "steering", step }];
      }

      return step.content.map((part) => ({
        kind: "part",
        part: part as AgentPart<AgentToolSet>,
        step,
      }));
    }
  );

  const lastEntry = entries.at(-1);
  // 只有最后一条仍是 assistant 文本时才是“答案”。若尾部是 steering step，
  // 说明回合在这里被切住，保持原顺序，不把任何内容提到链外。
  const answerPart =
    lastEntry?.kind === "part" && lastEntry.part.type === "text"
      ? lastEntry.part
      : undefined;
  const chainEntries = answerPart ? entries.slice(0, -1) : entries;

  return {
    entries: chainEntries,
    answerPart,
    // `summarizeTurn` 只统计 assistant part，steering 不参与。
    parts: chainEntries
      .filter(isPartEntry)
      .map(({ part, step }): StepRow => ({ part, step })),
  };
};
