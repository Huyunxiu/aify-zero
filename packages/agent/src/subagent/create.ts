import type {
  AgentAssistantTurn,
  AgentTextPart,
  AgentTurn,
  AgentTurnStatus,
  AgentUserTurn,
  ApprovalPolicy,
} from "@workspace/agent-client";
import type { ModelRef } from "@workspace/shared/model";
import type { ToolSet } from "ai";

import { AgentContext } from "../agent-context";
import { AgentSession } from "../agent-session";
import { Agent } from "../agents";
import { joinBlocks } from "../extensions/block";
import type { InstructionsSection } from "../extensions/types";
import type { CompactionStrategy } from "../kernel/compaction-strategy";
import type { ModelTargetResolver } from "../kernel/model-gateway";
import type { AgentStore } from "../storage";
import type { ToolApprovalPattern } from "../tool-approval";
import type { CallTargetResolver } from "../tools/execution";
import type { AgentToolSet, ToolExposure } from "../types";
import {
  generateSessionId,
  generateStepId,
  generateTurnId,
} from "../utils/id-util";
import { DEFAULT_SUBAGENT_TYPE } from "./definitions";
import type { SubagentDefinition } from "./definitions";
import { nextSubagentName } from "./names";

/** How many numbers one delegation tries before it gives up on a name. */
const NAME_ATTEMPTS = 3;

/**
 * The prompt a subagent reads: its own instruction, then every parent section.
 *
 * A section that speaks about a tool or an owner the subagent does not share
 * gives it its own text; one that has nothing to say to a subagent returns an
 * empty block, and the join leaves it out. `tools` is what the section needs to
 * decide: a rule about editing a file is not for an agent that cannot edit one.
 * This is the only place that decides, so the test reads the same seam the
 * runtime uses.
 */
export function renderSubagentInstructions(
  sections: readonly InstructionsSection[],
  instruction: string,
  tools: readonly string[]
): string {
  return joinBlocks([
    instruction,
    ...sections.map((section) =>
      section.renderForSubagent
        ? section.renderForSubagent(tools)
        : section.render()
    ),
  ]);
}

/**
 * A subagent may not delegate again, may not list or message its siblings, and
 * has no user to answer a questionnaire: all of these are barred whatever the
 * definition asks for.
 */
const FORBIDDEN_SUBAGENT_TOOLS = new Set([
  "create-subagent",
  "list-agents",
  "send-message",
  "stop-agent",
  "questionnaire",
]);

/**
 * The tools a subagent runs with.
 *
 * The delegation tools are dropped because a subagent that could delegate would
 * be able to recurse without bound, and nothing in the run counts the depth or
 * stops it. The three control tools go with it: a subagent holds no names to
 * address, because it holds no other subagents. `questionnaire` is dropped
 * because the subagent prompt already tells it the user cannot be asked
 * anything; offering the tool would only produce a form nobody is there to fill
 * in.
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
 * 子 agent 继承的一组「按工具名存的值」，只保留它留下来的那些工具。
 *
 * 暴露方式和转调解析函数都按名字查，所以白名单丢掉的工具如果还留一条记录，
 * 那条记录描述的是一个不存在的工具。只复制活下来的名字。
 */
export function restrictToTools<T>(
  records: ReadonlyMap<string, T>,
  tools: ToolSet
): Map<string, T> {
  const kept = new Map<string, T>();

  for (const [name, value] of records) {
    if (Object.hasOwn(tools, name)) {
      kept.set(name, value);
    }
  }

  return kept;
}

/**
 * The turn a prompt becomes, when the subagent is starting rather than
 * resuming. Built like any user turn: one step, holding one text part.
 */
export function buildPromptTurn(prompt: string): AgentUserTurn {
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

/** 把模型引用解析成调用目标。子 agent 继承父的这份函数，跑在别家的模型上也能拿到地址和密钥。 */
export type ProviderResolver = ModelTargetResolver;

export type SubagentHost = {
  /** The parent's environment: its project/session directories, skills, and model. */
  context: AgentContext;
  /** The pool the subagent's own tool set is drawn from. */
  tools: ToolSet;
  /**
   * 父的工具暴露方式。
   *
   * 子 agent 不重新注册扩展，工具集是从父继承的；暴露方式一起继承，否则父里
   * 藏进工具目录的 MCP 工具会在子会话里重新被声明，每步请求又背上它们的 schema。
   */
  toolExposure: ReadonlyMap<string, ToolExposure>;
  /**
   * 父的工具转调解析函数。
   *
   * 子 agent 不跑扩展，所以「转调」这件事只能跟着工具集过来；不继承的话
   * 父身上被藏进目录的 MCP 工具，在子会话里既不在声明集，也调不动。
   */
  toolRoute: ReadonlyMap<string, CallTargetResolver>;
  /** 父的模型解析函数：子 agent 用它解析自己的模型。 */
  resolveModel: ModelTargetResolver;
  /** The parent session's id. */
  sessionId: string;
  /**
   * 父的工具审批函数。
   *
   * 子 agent 不重新注册扩展，但工具集是从父继承的；函数一起继承，危险工具
   * 才不会换个会话就绕过审批。扩展的 `pre_tool_call` 只作用于注册它的
   * agent，不随工具集复制给子 agent。
   */
  toolApprovalPattern?: ToolApprovalPattern;
  /** 父的压缩策略；子 agent 继承它解析出的策略和摘要器。 */
  compaction?: CompactionStrategy;
  /**
   * The effective Approval Policy of the parent.
   *
   * The row of a child session is its own, and a missing value falls back to Standard
   * with no error. When the parent tightens to Standard, the child must not be looser.
   */
  approvalPolicy: ApprovalPolicy;
};

/**
 * The host, plus the call that is delegating.
 *
 * Building a child again needs the host and nothing else; only the first
 * delegation has a tool call to be idempotent against.
 */
export type SubagentParent = SubagentHost & {
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
  model?: ModelRef;
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
    botId,
    projectId,
    approvalPolicy,
    subagentType = DEFAULT_SUBAGENT_TYPE,
  }: {
    parentSessionId: string;
    toolCallId: string;
    description: string;
    prompt: string;
    /** Owning Bot of the parent session. */
    botId?: string;
    /** 父会话的项目归属；子会话跟着父走，列表按项目过滤时才不会漏掉它。 */
    projectId?: string;
    /** The effective policy of the parent. The child row copies it, or it falls back to Standard. */
    approvalPolicy: ApprovalPolicy;
    /**
     * The kind of subagent this row is.
     *
     * A row keeps it because a message can arrive long after the call that made
     * the child, and building it again needs to know what it was: a read-only
     * subagent must not come back as a general one.
     */
    subagentType?: string;
  }
): Promise<{
  sessionId: string;
  name: string | null;
  turns: AgentTurn<AgentToolSet>[];
}> {
  const existing = await store.findSessionByParentToolCall({
    parentSessionId,
    toolCallId,
  });

  if (existing) {
    const turns = AgentSession.toAgentTurns(
      await store.getBranchTurns(existing.id, {
        activeStreamId: existing.activeStreamId ?? undefined,
      })
    );

    // 行写了但一轮都没落下——进程恰好死在两次写之间。这种情况当作没跑过：
    // 喂一个空 transcript 会让子 agent 连自己的任务书都没有。
    if (turns.length === 0) {
      return {
        sessionId: existing.id,
        name: existing.subagentName,
        turns: [buildPromptTurn(prompt)],
      };
    }

    // 同一个调用再跑一次是「再给它说一句」，不是「把它说过的话丢掉」。这条
    // 路和递话走同一个追加：一个子会话只有一条往下的路。
    return {
      sessionId: existing.id,
      name: existing.subagentName,
      turns: [...turns, buildPromptTurn(prompt)],
    };
  }

  const sessionId = generateSessionId();

  // The name is decided by the insert, not before it: two delegations in flight
  // compute the same free number, and the unique index picks the winner. The
  // loser recomputes and takes the next number.
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
    const siblings = await store.listChildSessions(parentSessionId);
    const name = nextSubagentName(siblings.map((child) => child.subagentName));

    try {
      const saved = await store.saveSession({
        id: sessionId,
        title: description,
        metadata: { subagentType },
        kind: "subagent",
        parentSessionId,
        parentToolCallId: toolCallId,
        subagentName: name,
        ...(botId === undefined ? {} : { botId }),
        projectId,
        approvalPolicy,
      });

      if (saved) {
        return { sessionId, name, turns: [buildPromptTurn(prompt)] };
      }
    } catch {
      // A unique index refused the row: either the name is taken or this tool
      // call already landed. Both are answered by looking again.
    }
  }

  throw new Error(
    `could not allocate a subagent name under session ${parentSessionId}`
  );
}

/**
 * The subagent type a row was started as.
 *
 * It rides on the session row's metadata: a message can arrive long after the
 * call that made the child, and building the child again has to know what it
 * was. A read-only subagent must not come back as a general one. A row written
 * before types existed reads as general.
 */
export function subagentTypeOf(metadata: unknown): string {
  if (metadata !== null && typeof metadata === "object") {
    const value = (metadata as { subagentType?: unknown }).subagentType;
    if (typeof value === "string") {
      return value;
    }
  }

  return DEFAULT_SUBAGENT_TYPE;
}

export type Subagent = {
  agent: Agent;
  sessionId: string;
  /** The name the parent session reaches it by; null for a row older than names. */
  name: string | null;
  /** The turns to hand to {@link Agent.stream} to start it. */
  turns: AgentTurn<AgentToolSet>[];
};

/**
 * 子 agent 的压缩策略与摘要器。
 *
 * 子 agent 可能跑在与父不同的模型上，所以策略用父的那一份、按子自己的窗口
 * 重新解析；摘要器也用父的，协议事件和提示因此只有一处实现。父显式钉死过
 * 策略或摘要器时，原样继承。
 */
function subagentCompaction(
  parent: SubagentHost,
  model: ModelRef
): Pick<AgentContext, "compaction" | "summarize"> {
  const { context } = parent;
  const strategy = parent.compaction;
  if (!strategy) {
    return { compaction: context.compaction, summarize: context.summarize };
  }

  return {
    compaction: strategy.policy({
      contextWindow:
        context.modelContextWindows?.[model.providerId]?.[model.modelId],
      overrides: context.compactionOverrides,
    }),
    summarize: strategy.summarize(model),
  };
}

export async function createSubagent(
  parent: SubagentParent,
  options: CreateSubagentOptions
): Promise<Subagent> {
  const { store, description, prompt } = options;
  const { sessionId, name, turns } = await resolveSubagentSession(store, {
    parentSessionId: parent.sessionId,
    toolCallId: parent.toolCallId,
    description,
    prompt,
    botId: parent.context.botId,
    projectId: parent.context.projectId,
    approvalPolicy: parent.approvalPolicy,
    subagentType: options.definition.name,
  });
  const agent = buildSubagent(parent, { ...options, sessionId, turns });

  return { agent, sessionId, name, turns };
}

/**
 * Build the runnable Agent for a child session that already exists.
 *
 * The composition is the same whether the child is starting or being messaged
 * again: same parent context, same tool set, same model rule. Only the turns
 * differ, and the caller supplies them.
 */
export function buildSubagent(
  parent: SubagentHost,
  {
    definition,
    turns,
    sessionId: childSessionId,
    tools,
    model,
    store,
  }: {
    definition: SubagentDefinition;
    sessionId: string;
    turns: AgentTurn<AgentToolSet>[];
    tools?: ToolSet;
    model?: ModelRef;
    store: AgentStore;
  }
): Agent {
  const session = new AgentSession({ turns });
  const resolvedModel = model ?? definition.model ?? parent.context.model;

  const context = new AgentContext({
    sessionId: childSessionId,
    projectDirs: parent.context.projectDirs,
    // 子 agent 共享父会话的目录：它产出的临时文件属于同一个会话。
    sessionDir: parent.context.sessionDir,
    botId: parent.context.botId,
    botWorkspaceDir: parent.context.botWorkspaceDir,
    projectId: parent.context.projectId,
    model: resolvedModel,
    modelEffort: parent.context.modelEffort,
    // 提示片段跟着父上下文走：子 agent 不重新加载资源，看到的就是父所用的
    // 那一套，只是以子 agent 自己的 instructions 作为起点重新渲染。
    instructionsSections: parent.context.instructionsSections,
    ...subagentCompaction(parent, resolvedModel),
    modelContextWindows: parent.context.modelContextWindows,
    // 子 agent 继承父会话的工具集，工具闭包里绑定的是父上下文，所以后台
    // 任务同样归父会话所有。
    jobs: parent.context.jobs,
    // 沙箱同理：子 agent 在父会话的那个环境里跑，不另开一个。
    sandbox: parent.context.sandbox,
  });

  const subagentTools = selectSubagentTools(tools ?? parent.tools, definition);

  let { instructions } = definition;
  instructions = renderSubagentInstructions(
    parent.context.instructionsSections,
    instructions,
    Object.keys(subagentTools)
  );

  const agent = new Agent({
    name: `subagent:${definition.name}`,
    sessionId: childSessionId,
    approvalPolicy: parent.approvalPolicy,
    instructions,
    context,
    session,
    tools: subagentTools,
    toolExposure: restrictToTools(parent.toolExposure, subagentTools),
    toolRoute: restrictToTools(parent.toolRoute, subagentTools),
    store,
    model: resolvedModel,
    resolveModel: parent.resolveModel,
    modelEffort: parent.context.modelEffort,
    // No inherited abort scope. A parent's stop has two answers — take the
    // children with it, or leave them running — and a signal fixed at
    // construction could only ever give the first one. The session layer now
    // decides, once, at the moment it stops.
  });

  // A subagent registers no extensions, so the approval function is inherited
  // with the tool set; one the parent registers later does not reach it. The
  // inherited function folds `ask` into a refusal: nobody answers for a child,
  // and parking on a question no surface shows is worse than refusing it.
  if (parent.toolApprovalPattern) {
    agent.registerToolApprovalPattern(
      refuseAskingApproval(parent.toolApprovalPattern)
    );
  }

  return agent;
}

/**
 * The sentence a refused call carries, so the subagent can report the limit
 * instead of retrying it.
 */
export const SUBAGENT_APPROVAL_REFUSAL =
  "A subagent cannot ask for approval: its permission scope was fixed when it started, and nobody is on the other side of the question. Report the limit instead of retrying.";

/**
 * Inherit an approval function with its `ask` folded into a refusal.
 *
 * The policy is still the parent's: what it lets pass, the child lets pass. Only
 * the question has nowhere to go.
 */
export function refuseAskingApproval(
  pattern: ToolApprovalPattern
): ToolApprovalPattern {
  return async (request) => {
    const decision = await pattern(request);

    return decision?.decision === "ask"
      ? { decision: "deny", reason: SUBAGENT_APPROVAL_REFUSAL }
      : decision;
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
