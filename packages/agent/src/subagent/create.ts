import type {
  AgentAssistantTurn,
  AgentTextPart,
  AgentTurn,
  AgentTurnStatus,
  CompactionConfig,
} from "@workspace/agent-client";
import type { ToolSet } from "ai";

import { AgentContext } from "../agent-context";
import { AgentSession } from "../agent-session";
import { Agent } from "../agents";
import { MemoryAgentStore } from "../storage/memory-store";
import type { AgentToolSet } from "../types";
import {
  generateSessionId,
  generateStepId,
  generateTurnId,
} from "../utils/id-util";
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

/** Where a subagent's calls are sent: the parent's own provider and key. */
export type ProviderCredentials = {
  apiKey: string;
  apiUrl: string;
  providerId: string;
};

/**
 * The parts of a parent agent a subagent inherits.
 *
 * Passed as a small record rather than the parent `Agent` itself. A subagent
 * shares its parent's working directory, skills, model, and credentials, and
 * nothing else — handed the agent, it could reach for the session, store, and
 * transcript it is meant to be sealed off from.
 */
export type SubagentParent = {
  /** The parent's environment: its working directory, skills, and model. */
  context: AgentContext;
  /** The pool the subagent's own tool set is drawn from. */
  tools: ToolSet;
  /** The parent's credentials, so the child calls the same provider. */
  credentials: ProviderCredentials;
};

export type CreateSubagentOptions = {
  /** Which subagent to build: its instructions, tool allow-list, and model. */
  definition: SubagentDefinition;
  /** The task brief the subagent starts from — its only user turn. */
  prompt: string;
  /**
   * The tools it may use. Defaults to the parent's, minus `task`: a subagent
   * that could delegate would be able to recurse without bound.
   */
  tools?: ToolSet;
  /**
   * The model to run it on. Falls back to the definition's own, then to the
   * parent's.
   */
  modelId?: string;
};

/** A subagent, ready to be streamed. */
export type Subagent = {
  agent: Agent;
  /** The turns to hand to {@link Agent.stream} to start it. */
  turns: AgentTurn<AgentToolSet>[];
};

/**
 * Builds the agent that runs one subagent, wired to its parent.
 *
 * A subagent is a child of its parent rather than a peer: same working
 * directory, same skills, same provider and credentials, and no `task` tool,
 * so it cannot delegate in turn. What it does not share is memory — it starts
 * from the prompt alone, and the transcript it produces stays in its own
 * session rather than becoming part of the parent's conversation.
 *
 * It is not a session in the user's sense either. Its transcript belongs to
 * whichever call asked for it, so it is given a store that remembers nothing;
 * the session id it carries is its own only so its stream and its events can
 * be told apart from the parent's. It also carries its own compaction budget,
 * because the parent's already holds the token counts of a prompt this agent
 * never sent.
 */
export function createSubagent(
  parent: SubagentParent,
  { definition, prompt, tools, modelId }: CreateSubagentOptions
): Subagent {
  const turns = [buildPromptTurn(prompt)];
  const session = new AgentSession({ turns });
  const resolvedModelId =
    modelId ?? definition.modelId ?? parent.context.modelId;

  const compactionConfig: CompactionConfig = {
    ...parent.context.compactionConfig,
    lastKnownInputTokens: 0,
    lastKnownPromptMessageCount: 0,
  };

  const context = new AgentContext({
    workdir: parent.context.workdir,
    modelId: resolvedModelId,
    modelEffort: parent.context.modelEffort,
    skills: parent.context.skills,
    compactionConfig,
  });

  const childSessionId = generateSessionId();
  const agent = new Agent({
    name: `subagent:${definition.name}`,
    sessionId: childSessionId,
    systemPrompt: parent.context.skills.appendPrompt(definition.instructions),
    context,
    session,
    tools: selectSubagentTools(tools ?? parent.tools, definition),
    store: new MemoryAgentStore({
      sessionId: childSessionId,
      title: `subagent:${definition.name}`,
    }),
    apiKey: parent.credentials.apiKey,
    apiUrl: parent.credentials.apiUrl,
    providerId: parent.credentials.providerId,
    modelId: resolvedModelId,
    modelEffort: parent.context.modelEffort,
  });

  return { agent, turns };
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
