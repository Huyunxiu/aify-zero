import type { ApprovalPolicy, BotToolGroups } from "@workspace/agent-client";
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_BOT_TOOL_GROUPS,
} from "@workspace/agent-client";
import type { Sandbox } from "@workspace/sandbox";
import type { ModelEffort } from "@workspace/shared/constants";
import type { ModelRef } from "@workspace/shared/model";

import { AgentContext } from "./agent-context";
import type { ModelContextWindows } from "./agent-context";
import type { AgentSession } from "./agent-session";
import { Agent } from "./agents";
import { classifyTool } from "./approval-classes";
import type { ApprovalClassResolver } from "./approval-policy";
import { policyAnswer, resolveServiceDecision } from "./approval-policy";
import type { CompactionPolicyOverrides } from "./compaction/types";
import {
  ApprovalPolicyExtension,
  CompactionExtension,
  CoreInstructionsExtension,
  FileToolsExtension,
  JobsToolsExtension,
  QuestionnaireExtension,
  ShellToolsExtension,
  SubagentExtension,
  TimersToolsExtension,
  TitleExtension,
  ToolCatalogExtension,
  WebToolsExtension,
} from "./extensions/builtin";
import { MAIN_INSTRUCTIONS } from "./extensions/builtin/core-instructions";
import type { SubagentNotifier } from "./extensions/capabilities";
import { EnvironmentExtension } from "./extensions/environment";
import type { Extension } from "./extensions/types";
import type { SteeringSignal } from "./inbox/steering";
import type { JobRegistry } from "./jobs/registry";
import type { ModelTargetResolver } from "./kernel/model-gateway";
import type { AgentStore } from "./storage";
import type { StreamEventRegistry } from "./stream-registry";
import { STREAM_REGISTRY } from "./stream-registry";
import { createSubagentFactory } from "./subagent/factory";
import { bindSessionTimers } from "./timers/session-timers";
import type { TimerStore } from "./timers/types";
import type { ToolApprovalPattern } from "./tool-approval";
import { evaluateToolApproval } from "./tool-approval";
import { catalogEntries } from "./tool-catalog/catalog";
import type { JobToolOptions } from "./tools/jobs";
import type { AgentToolSet } from "./types";
import { timeZoneOrHost } from "./utils/time-zone";

/**
 * Composes the host's rules with the session's policy.
 *
 * The host answers first (the MCP annotation rules); the policy answers for the
 * class, and the two fold through `resolveServiceDecision`: the policy closes a
 * host's `ask`, and a refusal on either side stands. The class table replaced
 * the hard-coded set, so one place answers who gets asked for a built-in tool.
 */
function createToolApprovalPattern(input: {
  host: ToolApprovalPattern | undefined;
  policy: ApprovalPolicy;
  resolveClass: ApprovalClassResolver;
}): ToolApprovalPattern {
  return async (request) => {
    const toolClass = input.resolveClass(request);
    // The host side can throw: `evaluateToolApproval` treats a throw as no opinion, so a bad rule does not stop the Turn.
    const host = await evaluateToolApproval(input.host, request);

    return resolveServiceDecision(host, policyAnswer(input.policy, toolClass));
  };
}

/** Classify by the built-in table when no annotation is known. An MCP Tool falls to unknown, and the policy has no opinion. */
const defaultResolveApprovalClass: ApprovalClassResolver = (request) =>
  classifyTool(request.toolName);

export interface SessionModel {
  /** 会话起始使用的模型。 */
  ref: ModelRef;
  effort?: ModelEffort;
}

export interface SessionAgentOptions {
  sessionId: string;
  /** 默认 `main`；子 agent 走 {@link createSubagent}，不经过这里。 */
  name?: string;
  store: AgentStore;
  session: AgentSession;
  /** 运行器实例的注册表；省略时子会话用进程级单例。 */
  streamRegistry?: StreamEventRegistry<AgentToolSet>;
  /** Where a settled subagent reports. Absent when nobody listens. */
  subagentNotifier?: SubagentNotifier;
  /** How many subagents one session may run at once; the state package's default otherwise. */
  subagentLimit?: number;
  /** The wall clock one subagent run may take, in milliseconds. */
  subagentTimeoutMs?: number;
  model: SessionModel;
  /** 把模型引用解析成供应商的接入信息。 */
  resolveModel: ModelTargetResolver;
  /** 项目目录列表，第一项是主目录。 */
  projectDirs: readonly string[];
  /** 当前会话的私有目录。 */
  sessionDir: string;
  projectId?: string;
  /** Owning Bot identifier. */
  botId?: string;
  /** Persistent workspace directory of the owning Bot. */
  botWorkspaceDir?: string;
  /** Built-in tool groups enabled for this Bot; defaults to all enabled. */
  enabledToolGroups?: Partial<BotToolGroups>;
  /** 用户设置里的压缩开关；阈值由压缩策略按模型窗口解析。 */
  compactionOverrides?: CompactionPolicyOverrides;
  /** 每个已配置模型的上下文窗口，按供应商和模型两级索引。 */
  modelContextWindows?: ModelContextWindows;
  jobs?: JobRegistry;
  /** 任务工具的等待上限；省略时用工具里的默认值。 */
  jobTools?: JobToolOptions;
  /**
   * 定时器的存储面。省略时定时器工具不注册：这个会话排不了定时器。
   */
  timers?: TimerStore;
  /**
   * 日历规则缺省使用的 IANA 时区；省略时取宿主。
   *
   * 宿主应该传用户设置里的那一个：跑在 UTC 服务器上的时候，宿主时区不是用户
   * 的时区。
   */
  timeZone?: string;
  /** 用户插话信号；等待任务的工具用它提前结束阻塞。 */
  steering?: SteeringSignal;
  /**
   * 工具读写文件和运行命令的环境。必须由宿主决定：这里给默认值等于在装配处
   * 隐式选择适配器，和「选择必须是显式的」相悖（见 docs/adr/0008）。
   */
  sandbox: Sandbox;
  /**
   * 宿主自己的工具审批函数：按调用入参决定 deny / ask / allow。
   *
   * It returns undefined when it has no opinion; then the policy answers by Tool class. A
   * child agent inherits the composed function.
   */
  toolApprovalPattern?: ToolApprovalPattern;
  /**
   * The Approval Policy of the session; the default is `edit`.
   *
   * It decides only whether to ask: an ask for a change class, a refusal for a command. The Sandbox decides feasibility.
   */
  approvalPolicy?: ApprovalPolicy;
  /**
   * The resolution from Tool name to Approval Class; by default it reads the built-in table only.
   *
   * The host knows the annotations of its own Tools (MCP's readOnly / destructive), so it
   * injects this. Without it an MCP Tool falls to unknown, and the policy has no opinion.
   */
  resolveApprovalClass?: ApprovalClassResolver;
  /** The base system prompt; omitted means the main agent's identity. */
  instructions?: string;
  /** 宿主扩展，在默认扩展之后注册。 */
  extensions?: readonly Extension[];
}

/**
 * 装配一个会话 agent。
 *
 * 这是 `packages/agent` 里唯一的组合根：宿主给输入，这里决定默认扩展、
 * `AgentContext` 和 `Agent` 的构造顺序。新增默认能力时改这个文件，不改
 * 服务端路由。
 */
export async function createSessionAgent(
  options: SessionAgentOptions
): Promise<Agent> {
  const toolGroups: BotToolGroups = {
    ...DEFAULT_BOT_TOOL_GROUPS,
    ...options.enabledToolGroups,
  };
  const jobsEnabled = toolGroups.jobs && toolGroups.shell;

  // 定时器的视图在这里绑死：会话 id 和起跑配置由装配处决定，工具拿不到它们，
  // 也就排不出属于别的会话、用别的模型的定时器。到期那次运行用的是**设定时器
  // 时**的模型——进程重启之后内存里没有别的来源（ADR 0016）。
  const timers =
    !toolGroups.timers || options.timers === undefined
      ? undefined
      : bindSessionTimers(options.timers, {
          sessionId: options.sessionId,
          timeZone: timeZoneOrHost(options.timeZone),
          payload: {
            model: options.model.ref,
            ...(options.model.effort === undefined
              ? {}
              : { modelEffort: options.model.effort }),
            ...(options.projectId === undefined
              ? {}
              : { projectId: options.projectId }),
          },
        });

  const context = new AgentContext({
    sessionId: options.sessionId,
    projectDirs: options.projectDirs,
    sessionDir: options.sessionDir,
    projectId: options.projectId,
    botId: options.botId,
    botWorkspaceDir: options.botWorkspaceDir,
    model: options.model.ref,
    modelEffort: options.model.effort,
    compactionOverrides: options.compactionOverrides,
    modelContextWindows: options.modelContextWindows,
    jobs: jobsEnabled ? options.jobs : undefined,
    timers,
    steering: options.steering,
    sandbox: options.sandbox,
  });

  const approvalPolicy = options.approvalPolicy ?? DEFAULT_APPROVAL_POLICY;

  const agent = new Agent({
    name: options.name ?? "main",
    approvalPolicy,
    sessionId: options.sessionId,
    context,
    session: options.session,
    store: options.store,
    model: options.model.ref,
    modelEffort: options.model.effort,
    resolveModel: options.resolveModel,
    ...(toolGroups.subagent
      ? {
          subagentFactory: (owner) =>
            createSubagentFactory({
              agent: owner,
              store: options.store,
              registry:
                options.streamRegistry ??
                (STREAM_REGISTRY as StreamEventRegistry<AgentToolSet>),
              ...(options.subagentNotifier === undefined
                ? {}
                : { notifier: options.subagentNotifier }),
              ...(options.subagentLimit === undefined
                ? {}
                : { limit: options.subagentLimit }),
              ...(options.subagentTimeoutMs === undefined
                ? {}
                : { timeoutMs: options.subagentTimeoutMs }),
            }),
        }
      : {}),
  });

  try {
    // The host rules and the policy combine into one approval function. An Extension no longer states approval.
    agent.registerToolApprovalPattern(
      createToolApprovalPattern({
        host: options.toolApprovalPattern,
        policy: approvalPolicy,
        resolveClass:
          options.resolveApprovalClass ?? defaultResolveApprovalClass,
      })
    );

    await agent.registerExtension(
      new EnvironmentExtension({ id: "environment" })
    );
    // The rules come before the environment facts: how to work, then where.
    await agent.registerExtension(
      new CoreInstructionsExtension({ id: "core-instructions" })
    );
    await agent.registerExtension(
      new ApprovalPolicyExtension({ id: "approval", policy: approvalPolicy })
    );
    await agent.registerExtension(
      new CompactionExtension({ id: "compaction" })
    );
    await agent.registerExtension(new TitleExtension({ id: "title" }));
    if (toolGroups.files) {
      await agent.registerExtension(new FileToolsExtension());
    }
    if (toolGroups.shell) {
      await agent.registerExtension(new ShellToolsExtension());
    }
    if (toolGroups.web) {
      await agent.registerExtension(new WebToolsExtension());
    }
    if (jobsEnabled) {
      await agent.registerExtension(
        new JobsToolsExtension({
          id: "jobs-tools",
          ...(options.jobTools === undefined
            ? {}
            : { toolOptions: options.jobTools }),
        })
      );
    }
    if (toolGroups.timers) {
      await agent.registerExtension(
        new TimersToolsExtension({ id: "timers-tools" })
      );
    }
    await agent.registerExtension(new QuestionnaireExtension());
    if (toolGroups.subagent) {
      await agent.registerExtension(new SubagentExtension());
    }
    // 宿主扩展（MCP 等）在这一句之后注册，所以 `entries` 读的必须是活的工具集，
    // 而不是此刻的条目快照。
    await agent.registerExtension(
      new ToolCatalogExtension({
        id: "tool-catalog",
        entries: () => catalogEntries(agent.tools, agent.toolExposure),
      })
    );

    for (const extension of options.extensions ?? []) {
      await agent.registerExtension(extension);
    }
  } catch (error) {
    // 半成品 agent 不该留在内存里：已经注册的扩展在这里收掉。
    await agent.dispose();
    throw error;
  }

  agent.instructions = options.instructions ?? MAIN_INSTRUCTIONS;

  return agent;
}
