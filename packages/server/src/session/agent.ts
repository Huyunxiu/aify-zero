import { mkdirSync } from "node:fs";

import {
  createMcpToolApprovalPattern,
  createSessionAgent,
  ContextExtension,
  FileSystemContextSource,
  FileSystemSkillSource,
  McpExtension,
  SkillExtension,
} from "@workspace/agent";
import type { Agent } from "@workspace/agent";
import type { AgentSession } from "@workspace/agent/agent-session";
import type { ModelEffort } from "@workspace/shared/constants";

import { getSessionDir } from "../config";
import { JOB_REGISTRY } from "../jobs";
import { getMcpManager } from "../mcp/registry";
import { getProjectDirs } from "../routers/project/project.service";
import type { AiModel } from "../routers/settings/settings.schema";
import { getUserSettings } from "../routers/settings/settings.service";
import type { SQLiteStore } from "../storage/sqlite-store";

export interface BuildSessionAgentInput {
  sessionId: string;
  aiModel: AiModel;
  effort?: ModelEffort;
  projectId?: string;
  session: AgentSession;
  store: SQLiteStore;
}

/**
 * 建一个会话用的 agent：目录、策略、扩展和工具都按这个会话装配好。
 *
 * 建回合和手工压缩共用这一段；差别只在 AgentSession 里有什么、以及接下来
 * 调用 `stream` 时发哪种 signal。
 */
export async function buildSessionAgent({
  sessionId,
  aiModel,
  effort,
  projectId,
  session,
  store,
}: BuildSessionAgentInput): Promise<Agent> {
  // 会话目录先建出来：Environment 提示会把路径告诉模型，模型可能直接往里
  // 写文件，不该让它先自己 mkdir。
  const sessionDir = getSessionDir(sessionId);
  mkdirSync(sessionDir, { recursive: true });

  // 目录来自 project 表：会话指定了项目就用那个项目，否则用默认项目。
  const projectDirs = await getProjectDirs(projectId);

  const settings = await getUserSettings();
  const modelContextWindows = Object.fromEntries(
    settings.models
      .filter((configured) => (configured.limit?.context ?? 0) > 0)
      .map((configured) => [configured.model, configured.limit?.context ?? 0])
  );

  // 默认扩展和工具装配由 agent 包的组合根决定；这里只提供宿主才能知道的
  // 东西：目录、模型、设置和文件系统资源。
  //
  // MCP 连接归进程，不归会话：每回合都会走到这里，扩展只向管理器要快照。
  const mcpManager = getMcpManager();

  return await createSessionAgent({
    sessionId,
    store,
    session,
    model: {
      id: aiModel.model,
      apiKey: aiModel.apiKey,
      apiUrl: aiModel.apiUrl,
      providerId: aiModel.provider,
      effort,
    },
    projectDirs,
    sessionDir,
    projectId,
    compactionOverrides: settings.compaction,
    modelContextWindows,
    jobs: JOB_REGISTRY,
    // 审批放进宿主的函数，子会话才能继承 MCP 工具的询问规则。
    toolApprovalPattern: createMcpToolApprovalPattern(mcpManager),
    extensions: [
      new McpExtension({
        id: "mcp",
        manager: mcpManager,
        servers: settings.mcpServers,
      }),
      new SkillExtension({
        id: "filesystem-skills",
        sources: [new FileSystemSkillSource()],
      }),
      new ContextExtension({
        id: "filesystem-context",
        sources: [new FileSystemContextSource()],
      }),
    ],
  });
}
