import type {
  AgentAssistantTurn,
  AgentTextPart,
  AgentTurn,
  AgentTurnStatus,
  CompactionConfig,
} from "@workspace/agent-client";
import type { ToolSet } from "ai";

import type { AgentToolSet } from "../types";
import { generateStepId, generateTurnId } from "../utils/id-util";
import type { SubagentDefinition } from "./definitions";

/** A subagent may not delegate again, so the tool that would let it is barred. */
const FORBIDDEN_SUBAGENT_TOOLS = new Set(["task"]);

/**
 * The tools a subagent runs with.
 *
 * `task` is dropped whatever the definition asks for: a subagent that could
 * delegate would be able to recurse without bound, and its transcript has
 * nowhere to put a third level.
 */
export function selectSubagentTools(
  tools: ToolSet,
  definition: SubagentDefinition
): ToolSet {
  const allowed = definition.tools ? new Set(definition.tools) : undefined;

  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name]) =>
        !FORBIDDEN_SUBAGENT_TOOLS.has(name) && (!allowed || allowed.has(name))
    )
  );
}

/**
 * The turn a prompt becomes, when the subagent is starting rather than
 * resuming. Built like any user turn: one step, holding one text part.
 */
export function buildPromptTurn(prompt: string): AgentTurn<AgentToolSet> {
  const createdAt = Date.now();

  return {
    id: generateTurnId(),
    type: "user",
    createdAt,
    status: "done",
    content: [
      {
        id: generateStepId(),
        type: "user",
        createdAt,
        status: "done",
        content: [{ type: "text", text: prompt, state: "done", createdAt }],
      },
    ],
  };
}

/**
 * A subagent's compaction budget.
 *
 * Built per subagent rather than shared: the config carries the token counts of
 * the step that last ran, so one object passed to several subagents would let
 * each read the other's numbers and compact against a prompt it never sent.
 */
export function createSubagentCompactionConfig(): CompactionConfig {
  return {
    recentWindowSize: 10,
    threshold: 100_000,
    thresholdPercent: 0.9,
    lastKnownInputTokens: 0,
    lastKnownPromptMessageCount: 0,
  };
}

/** What a finished subagent left behind for the parent to read. */
export type SubagentResult = {
  /** The last thing it said — the report it was told to finish on. */
  report: string;
  /** How its turn ended, in the turn's own vocabulary. */
  status: AgentTurnStatus["status"];
};

export function readSubagentResult(
  turns: readonly AgentTurn<AgentToolSet>[]
): SubagentResult {
  const turn = turns.findLast(
    (candidate): candidate is AgentAssistantTurn<AgentToolSet> =>
      candidate.type === "assistant"
  );

  if (!turn) {
    return { report: "", status: "error" };
  }

  const parts = turn.content.flatMap((step) =>
    step.content.map((part) => ({ part }))
  );

  const answerPartIndex =
    parts.at(-1)?.part.type === "text" ? parts.length - 1 : -1;
  const answerPart =
    answerPartIndex === -1
      ? undefined
      : (parts[answerPartIndex]?.part as AgentTextPart | undefined);

  return { report: answerPart?.text || "", status: turn.status };
}
