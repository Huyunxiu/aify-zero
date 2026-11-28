import { mkdirSync } from "node:fs";

import {
  classifyTool,
  createMcpToolApprovalPattern,
  createSessionAgent,
  ContextExtension,
  mcpApprovalClass,
  McpExtension,
  SkillExtension,
  timeZoneOrHost,
} from "@workspace/agent";
import type {
  Agent,
  ApprovalClassResolver,
  BuildAgentInput,
  JobRegistry,
  McpManager,
  SteeringSignal,
  NoticeWriter,
} from "@workspace/agent";
import type { ApprovalPolicy } from "@workspace/agent-client";
import type { ModelEffort } from "@workspace/shared/constants";

import { getSessionDir } from "../config";
import { JOB_REGISTRY } from "../jobs";
import { getMcpManager } from "../mcp/registry";
import { resolveEffectiveMcpServers } from "../routers/bot/bot.service";
import type { ConfiguredModel } from "../routers/settings/settings.schema";
import { getUserSettings } from "../routers/settings/settings.service";
import { acquireSessionSandbox } from "../sandbox/registry";
import type { SQLiteStore } from "../storage/sqlite-store";
import {
  createBotContextSource,
  createBotSkillSource,
  resolveSessionDirectories,
} from "./directories";
import {
  createModelTargetResolver,
  modelContextWindows,
} from "./model-targets";

export interface BuildSessionAgentInput {
  sessionId: string;
  configured: ConfiguredModel;
  effort?: ModelEffort;
  botId?: string;
  projectId?: string;
  session: BuildAgentInput["session"];
  store: SQLiteStore;
  /** Runner stream registry; child sessions share it. */
  streams: BuildAgentInput["streams"];
  jobs?: JobRegistry;
  steering?: SteeringSignal;
  /** The Approval Policy of the session, which this Run uses as it is. */
  approvalPolicy: ApprovalPolicy;
  /** The notice writer this run was given; absent in tests that do not settle. */
  notices?: NoticeWriter;
  /** How many subagents one session may run at once. */
  subagentLimit?: number;
  /** The wall clock one subagent run may take, in milliseconds. */
  subagentTimeoutMs?: number;
}

/**
 * Assemble a session's agent: Bot & Project directories, sandbox, policy, extensions, and tools.
 *
 * Shared by active turns and manual compaction runs.
 */
export async function buildSessionAgent({
  sessionId,
  configured,
  effort,
  botId,
  projectId,
  session,
  store,
  streams,
  jobs,
  steering,
  approvalPolicy,
  notices,
  subagentLimit,
  subagentTimeoutMs,
}: BuildSessionAgentInput): Promise<Agent> {
  const sessionDir = getSessionDir(sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const dirs = await resolveSessionDirectories({ botId, projectId });
  const { bot } = dirs;

  const [sandbox, settings] = await Promise.all([
    acquireSessionSandbox({
      sessionId,
      projectDirs: dirs.projectDirs,
      sessionDir,
      sandbox: bot.sandbox,
      readOnlyDirs: [dirs.botSkillsDir],
      env: bot.env,
      homeDir: dirs.botIsolatedHomeDir,
    }),
    getUserSettings(),
  ]);
  const timeZone = timeZoneOrHost(settings.timeZone);
  const mcpManager = getMcpManager();
  const effectiveMcpServers = resolveEffectiveMcpServers(
    bot,
    settings.mcpServers
  );
  const effectiveMcpServerIds = new Set(
    effectiveMcpServers.map((server) => server.id)
  );
  const compactionOverrides = bot.compaction
    ? { ...settings.compaction, ...bot.compaction }
    : settings.compaction;

  return await createSessionAgent({
    sessionId,
    store,
    session,
    streamRegistry: streams,
    model: { ref: configured.ref, effort },
    resolveModel: createModelTargetResolver(settings),
    projectDirs: dirs.projectDirs,
    sessionDir,
    projectId: dirs.hasProject ? projectId : undefined,
    botId: bot.id,
    botWorkspaceDir: dirs.botWorkspaceDir,
    enabledToolGroups: bot.toolGroups,
    compactionOverrides,
    modelContextWindows: modelContextWindows(settings),
    jobs: jobs ?? JOB_REGISTRY,
    timers: store,
    timeZone,
    steering,
    ...(notices === undefined ? {} : { notices }),
    ...(subagentLimit === undefined ? {} : { subagentLimit }),
    ...(subagentTimeoutMs === undefined ? {} : { subagentTimeoutMs }),
    sandbox,
    toolApprovalPattern: createMcpToolApprovalPattern(
      mcpManager,
      effectiveMcpServerIds
    ),
    approvalPolicy,
    resolveApprovalClass: resolveApprovalClass(
      mcpManager,
      effectiveMcpServerIds
    ),
    instructions: bot.instructions?.trim() ? bot.instructions : undefined,
    extensions: [
      new McpExtension({
        id: "mcp",
        manager: mcpManager,
        servers: effectiveMcpServers,
      }),
      new SkillExtension({
        id: "filesystem-skills",
        sources: [createBotSkillSource(dirs)],
      }),
      new ContextExtension({
        id: "filesystem-context",
        sources: [createBotContextSource(dirs)],
      }),
    ],
  });
}

function resolveApprovalClass(
  mcpManager: McpManager,
  serverIds: ReadonlySet<string>
): ApprovalClassResolver {
  return (request) =>
    mcpApprovalClass(mcpManager, request.toolName, serverIds) ??
    classifyTool(request.toolName);
}
