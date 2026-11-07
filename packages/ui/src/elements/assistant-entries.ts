import type { AgentToolSet } from "@workspace/agent";
import { isAgentTextPart } from "@workspace/agent-client";
import type {
  AgentAssistantStep,
  AgentAssistantTurn,
  AgentCompactionStep,
  AgentPart,
  AgentSteeringStep,
  AgentTextPart,
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

/** 一行文本 part：只有它可能承担“答案”。 */
const isTextEntry = (
  entry: AssistantEntry
): entry is Extract<AssistantEntry, { kind: "part" }> & {
  part: AgentTextPart;
} => entry.kind === "part" && isAgentTextPart(entry.part);

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

  // 答案取最后一条 assistant 文本：它后面可能还跟着工具调用或 steering，
  // 那些行留在链里，文本本身提到链外单独渲染。
  const lastEntry = entries.findLast(isTextEntry);
  const answerPart = lastEntry?.part;
  const chainEntries = lastEntry
    ? entries.filter((entry) => entry !== lastEntry)
    : entries;

  return {
    entries: chainEntries,
    answerPart,
    // `summarizeTurn` 只统计 assistant part，steering 不参与。
    parts: chainEntries
      .filter(isPartEntry)
      .map(({ part, step }): StepRow => ({ part, step })),
  };
};
