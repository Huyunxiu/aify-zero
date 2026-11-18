import { mkdirSync } from "node:fs";

import {
  createMcpToolApprovalPattern,
  createSessionAgent,
  ContextExtension,
  FileSystemContextSource,
  FileSystemSkillSource,
  McpExtension,
  SkillExtension,
  timeZoneOrHost,
} from "@workspace/agent";
import type {
  Agent,
  BuildAgentInput,
  JobRegistry,
  SteeringSignal,
} from "@workspace/agent";
import type { ModelEffort } from "@workspace/shared/constants";

import { getSessionDir } from "../config";
import { JOB_REGISTRY } from "../jobs";
import { getMcpManager } from "../mcp/registry";
import { getProjectDirs } from "../routers/project/project.service";
import type { ConfiguredModel } from "../routers/settings/settings.schema";
import { getUserSettings } from "../routers/settings/settings.service";
import { acquireSessionSandbox } from "../sandbox/registry";
import type { SQLiteStore } from "../storage/sqlite-store";
import {
  createModelTargetResolver,
  modelContextWindows,
} from "./model-targets";

export interface BuildSessionAgentInput {
  sessionId: string;
  configured: ConfiguredModel;
  effort?: ModelEffort;
  projectId?: string;
  session: BuildAgentInput["session"];
  store: SQLiteStore;
  /** 运行器实例的注册表；子会话必须复用它。 */
  streams: BuildAgentInput["streams"];
  jobs?: JobRegistry;
  /** 运行器的插话信号；等待任务的工具订阅它。 */
  steering?: SteeringSignal;
}

/**
 * 建一个会话用的 agent：目录、策略、扩展和工具都按这个会话装配好。
 *
 * 建回合和手工压缩共用这一段；差别只在 AgentSession 里有什么、以及接下来
 * 调用 `stream` 时发哪种 signal。
 */
export async function buildSessionAgent({
  sessionId,
  configured,
  effort,
  projectId,
  session,
  store,
  streams,
  jobs,
  steering,
}: BuildSessionAgentInput): Promise<Agent> {
  // 会话目录先建出来：Environment 提示会把路径告诉模型，模型可能直接往里
  // 写文件，不该让它先自己 mkdir。
  const sessionDir = getSessionDir(sessionId);
  mkdirSync(sessionDir, { recursive: true });

  // 目录来自 project 表：会话指定了项目就用那个项目，否则用默认项目。
  const projectDirs = await getProjectDirs(projectId);

  // 沙箱按会话缓存：它要比一次请求活得久，远端实例尤其不能被每回合重建。
  const sandbox = await acquireSessionSandbox({
    sessionId,
    projectDirs,
    sessionDir,
  });

  const settings = await getUserSettings();
  // 日历规则的缺省时区：设置里写死的优先，没写就跟随宿主。定下来之后由工具
  // 写进每一条日程，之后不再跟随（ADR 0018）。设置刚读过，不再查一次库。
  const timeZone = timeZoneOrHost(settings.timeZone);

  // 默认扩展和工具装配由 agent 包的组合根决定；这里只提供宿主才能知道的
  // 东西：目录、模型、设置和文件系统资源。
  //
  // MCP 连接归进程，不归会话：每回合都会走到这里，扩展只向管理器要快照。
  const mcpManager = getMcpManager();

  return await createSessionAgent({
    sessionId,
    store,
    session,
    streamRegistry: streams,
    model: { ref: configured.ref, effort },
    resolveModel: createModelTargetResolver(settings),
    projectDirs,
    sessionDir,
    projectId,
    compactionOverrides: settings.compaction,
    modelContextWindows: modelContextWindows(settings),
    jobs: jobs ?? JOB_REGISTRY,
    // 定时器和收件箱共用同一个库：会话排的定时器就落在它自己的存储上。
    timers: store,
    timeZone,
    steering,
    sandbox,
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
