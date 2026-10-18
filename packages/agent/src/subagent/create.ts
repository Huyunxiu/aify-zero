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
import type { AgentStore } from "../storage";
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
 * delegate would be able to recurse without bound, and nothing in the run
 * counts the depth or stops it.
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

export type SubagentParent = {
  /** The parent's environment: its working directory, skills, and model. */
  context: AgentContext;
  /** The pool the subagent's own tool set is drawn from. */
  tools: ToolSet;
  /** The parent's credentials, so the child calls the same provider. */
  credentials: ProviderCredentials;
  /** 派生它的父会话 id。 */
  sessionId: string;
  /** 父会话里这次 `task` 调用的 id。和父会话 id 一起唯一确定一个子会话。 */
  toolCallId: string;
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
  store: AgentStore;
  description: string;
};

/**
 * 决定这次 `task` 调用在哪个子会话里跑，并把该会话的行准备好。
 *
 * 父 turn 被 resume 时同一个调用会再执行一遍，所以先按 (父会话, 工具调用 id)
 * 找已经派生过的那次：找到就接着它的 transcript 往下走，找不到才新建。这样
 * 一次调用始终只对应一个子会话，不会每 resume 一次就多一行、多跑一遍。
 *
 * 新建时这一行必须在 `stream` 之前写进去，而且带一个非空 title：运行时读这
 * 一行来决定要不要生成标题，读不到就为一个没人看的会话白花一次模型调用，
 * 还会往子流上写 `session.title.*` 事件。
 */
export async function resolveSubagentSession(
  store: AgentStore,
  {
    parentSessionId,
    toolCallId,
    description,
    prompt,
  }: {
    parentSessionId: string;
    toolCallId: string;
    description: string;
    prompt: string;
  }
): Promise<{ sessionId: string; turns: AgentTurn<AgentToolSet>[] }> {
  const existing = await store.findSessionByParentToolCall({
    parentSessionId,
    toolCallId,
  });

  if (existing) {
    const turns = AgentSession.toAgentTurns(
      await store.getBranchTurns(existing.id)
    );

    // 行写了但一轮都没落下——进程恰好死在两次写之间。这种情况当作没跑过：
    // 喂一个空 transcript 会让子 agent 连自己的任务书都没有。
    return {
      sessionId: existing.id,
      turns: turns.length > 0 ? turns : [buildPromptTurn(prompt)],
    };
  }

  const sessionId = generateSessionId();
  await store.saveSession({
    id: sessionId,
    title: description,
    metadata: {},
    kind: "subagent",
    parentSessionId,
    parentToolCallId: toolCallId,
  });

  return { sessionId, turns: [buildPromptTurn(prompt)] };
}

export type Subagent = {
  agent: Agent;
  /** The turns to hand to {@link Agent.stream} to start it. */
  turns: AgentTurn<AgentToolSet>[];
};

export async function createSubagent(
  parent: SubagentParent,
  {
    definition,
    prompt,
    tools,
    modelId,
    store,
    description,
  }: CreateSubagentOptions
): Promise<Subagent> {
  const { sessionId: childSessionId, turns } = await resolveSubagentSession(
    store,
    {
      parentSessionId: parent.sessionId,
      toolCallId: parent.toolCallId,
      description,
      prompt,
    }
  );
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

  const agent = new Agent({
    name: `subagent:${definition.name}`,
    sessionId: childSessionId,
    systemPrompt: parent.context.skills.appendPrompt(definition.instructions),
    context,
    session,
    tools: selectSubagentTools(tools ?? parent.tools, definition),
    store,
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
