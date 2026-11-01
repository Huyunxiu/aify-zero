import type { ModelEffort } from "@workspace/shared/constants";

import { AgentContext } from "./agent-context";
import type { AgentSession } from "./agent-session";
import { Agent } from "./agents";
import type { CompactionPolicyOverrides } from "./compaction/types";
import { ApprovalExtension } from "./extensions/approvals";
import {
  CompactionExtension,
  FileToolsExtension,
  JobsToolsExtension,
  QuestionnaireExtension,
  ShellToolsExtension,
  SubagentExtension,
  TitleExtension,
  WebToolsExtension,
} from "./extensions/builtin";
import { EnvironmentExtension } from "./extensions/environment";
import type { Extension } from "./extensions/types";
import type { JobRegistry } from "./jobs/registry";
import type { AgentStore } from "./storage";
import { appendSubagentPrompt } from "./subagent/definitions";
import { createSubagentFactory } from "./subagent/factory";

export interface SessionModel {
  id: string;
  apiKey: string;
  apiUrl: string;
  providerId: string;
  effort?: ModelEffort;
}

export interface SessionAgentOptions {
  sessionId: string;
  /** 默认 `main`；子 agent 走 {@link createSubagent}，不经过这里。 */
  name?: string;
  store: AgentStore;
  session: AgentSession;
  model: SessionModel;
  /** 项目目录列表，第一项是主目录。 */
  projectDirs: readonly string[];
  /** 当前会话的私有目录。 */
  sessionDir: string;
  projectId?: string;
  /** 用户设置里的压缩开关；阈值由压缩策略按模型窗口解析。 */
  compactionOverrides?: CompactionPolicyOverrides;
  /** 每个已配置模型的上下文窗口，按 model id 索引。 */
  modelContextWindows?: Readonly<Record<string, number>>;
  jobs?: JobRegistry;
  /**
   * 宿主工具自己的审批名单。默认工具（write-file、delete-file、
   * questionnaire）由各自的扩展声明，不要在这里重复列。
   */
  approvalRequired?: readonly string[];
  /** 系统提示的起点；子 agent 说明会追加在后面。 */
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
  const context = new AgentContext({
    sessionId: options.sessionId,
    projectDirs: options.projectDirs,
    sessionDir: options.sessionDir,
    projectId: options.projectId,
    modelId: options.model.id,
    modelEffort: options.model.effort,
    compactionOverrides: options.compactionOverrides,
    modelContextWindows: options.modelContextWindows,
    jobs: options.jobs,
  });

  const agent = new Agent({
    name: options.name ?? "main",
    sessionId: options.sessionId,
    context,
    session: options.session,
    store: options.store,
    apiKey: options.model.apiKey,
    apiUrl: options.model.apiUrl,
    providerId: options.model.providerId,
    modelId: options.model.id,
    modelEffort: options.model.effort,
    subagentFactory: (owner) =>
      createSubagentFactory({ agent: owner, store: options.store }),
  });

  try {
    // 默认工具自己声明审批；这里只补宿主额外要求的名字。
    if (options.approvalRequired && options.approvalRequired.length > 0) {
      await agent.registerExtension(
        new ApprovalExtension({
          id: "approvals",
          tools: options.approvalRequired,
        })
      );
    }

    await agent.registerExtension(
      new EnvironmentExtension({ id: "environment" })
    );
    await agent.registerExtension(
      new CompactionExtension({ id: "compaction" })
    );
    await agent.registerExtension(new TitleExtension({ id: "title" }));
    await agent.registerExtension(new FileToolsExtension());
    await agent.registerExtension(new ShellToolsExtension());
    await agent.registerExtension(new WebToolsExtension());
    await agent.registerExtension(new JobsToolsExtension());
    await agent.registerExtension(new QuestionnaireExtension());
    await agent.registerExtension(new SubagentExtension());

    for (const extension of options.extensions ?? []) {
      await agent.registerExtension(extension);
    }
  } catch (error) {
    // 半成品 agent 不该留在内存里：已经注册的扩展在这里收掉。
    await agent.dispose();
    throw error;
  }

  agent.instructions = appendSubagentPrompt(options.instructions ?? "");

  return agent;
}
