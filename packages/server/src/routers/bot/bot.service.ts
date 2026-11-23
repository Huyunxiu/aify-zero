import { randomUUID } from "node:crypto";

import type { McpServerConfig } from "@workspace/agent";
import type {
  BotCompactionOverride,
  BotDetail,
  BotMcpConfig,
  BotSandboxConfig,
  BotSkillsConfig,
  BotSummary,
  BotToolGroups,
} from "@workspace/agent-client";
import {
  botCompactionOverrideSchema,
  botEffortSchema,
  botSandboxConfigSchema,
  botSkillsConfigSchema,
  botToolGroupsSchema,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_BOT_ID,
  DEFAULT_BOT_MCP_CONFIG,
  DEFAULT_BOT_NAME,
  DEFAULT_BOT_SANDBOX_CONFIG,
  DEFAULT_BOT_SKILLS_CONFIG,
  DEFAULT_BOT_TOOL_GROUPS,
} from "@workspace/agent-client";
import { SKILL_DIRS, SkillManager } from "@workspace/agent/skill";
import type { SkillInfo } from "@workspace/agent/skill";
import type { BotModel } from "@workspace/db";
import type { ModelEffort } from "@workspace/shared/constants";
import type { ModelRef } from "@workspace/shared/model";

import {
  ensureBotDirs,
  getBotHomeDir,
  getBotSkillsDir,
  getBotWorkspaceDir,
} from "../../config";
import { ApiError } from "../../errors";
import { hasMcpTokens } from "../../mcp/credentials";
import { dropStaleMcpCredentials } from "../../mcp/credentials-cleanup";
import { mcpAuthorizationFlows } from "../../mcp/oauth";
import { getMcpManager } from "../../mcp/registry";
import {
  assertUniqueMcpAcrossGlobalAndBots,
  parseBotMcpConfig,
  selectInheritedGlobalMcpServers,
} from "../../mcp/validate";
import { findProjectById } from "../project/project.repository";
import { getUserSettings } from "../settings/settings.service";
import {
  findBotById,
  insertBot,
  listActiveBots,
  updateBotRow,
} from "./bot.repository";
import type { CreateBotInput, UpdateBotInput } from "./bot.schema";

export interface NormalizedBot {
  id: string;
  isDefault: boolean;
  name: string;
  avatar: string | null;
  description: string | null;
  instructions: string | null;
  defaultModel: ModelRef | null;
  defaultEffort: ModelEffort | null;
  defaultProjectId: string | null;
  workspaceDirOverride: string | null;
  defaultApprovalPolicy: BotDetail["defaultApprovalPolicy"];
  toolGroups: BotToolGroups;
  sandbox: BotSandboxConfig;
  env: Record<string, string>;
  skills: BotSkillsConfig;
  mcp: BotMcpConfig;
  includeGlobalContext: boolean;
  compaction: BotCompactionOverride | null;
  createdAt: number;
  updatedAt: number;
}

function normalizeToolGroups(
  input: Partial<BotToolGroups> | null | undefined
): BotToolGroups {
  const parsed = botToolGroupsSchema.safeParse({
    ...DEFAULT_BOT_TOOL_GROUPS,
    ...input,
  });
  const groups = parsed.success ? parsed.data : { ...DEFAULT_BOT_TOOL_GROUPS };
  // Jobs require shell execution; disabling shell disables background jobs too.
  if (!groups.shell) {
    return { ...groups, jobs: false };
  }
  return groups;
}

/** Normalize a stored Bot row into a strictly typed domain object. */
export function normalizeBotRow(row: BotModel): NormalizedBot {
  const parsedEffort = botEffortSchema.safeParse(row.defaultEffort);
  const parsedSandbox = botSandboxConfigSchema.safeParse(row.sandbox);
  const parsedSkills = botSkillsConfigSchema.safeParse(row.skills);
  const parsedCompaction = row.compaction
    ? botCompactionOverrideSchema.safeParse(row.compaction)
    : undefined;

  return {
    id: row.id,
    isDefault: row.id === DEFAULT_BOT_ID,
    name: row.name,
    avatar: row.avatar ?? null,
    description: row.description ?? null,
    instructions: row.instructions ?? null,
    defaultModel: row.defaultModel ?? null,
    defaultEffort: parsedEffort.success ? parsedEffort.data : null,
    defaultProjectId: row.defaultProjectId ?? null,
    workspaceDirOverride: row.workspaceDir ?? null,
    defaultApprovalPolicy: row.defaultApprovalPolicy ?? DEFAULT_APPROVAL_POLICY,
    toolGroups: normalizeToolGroups(row.toolGroups),
    sandbox: parsedSandbox.success
      ? parsedSandbox.data
      : { ...DEFAULT_BOT_SANDBOX_CONFIG },
    env: row.env && typeof row.env === "object" ? { ...row.env } : {},
    skills: parsedSkills.success
      ? parsedSkills.data
      : { ...DEFAULT_BOT_SKILLS_CONFIG },
    mcp: parseBotMcpConfig(row.mcp),
    includeGlobalContext: row.includeGlobalContext,
    compaction: parsedCompaction?.success ? parsedCompaction.data : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** Resolve the Bot Workspace directory, respecting any reserved host override column. */
export function resolveBotWorkspaceDir(bot: {
  id: string;
  workspaceDirOverride?: string | null;
}): string {
  const override = bot.workspaceDirOverride?.trim();
  return override !== undefined && override.length > 0
    ? override
    : getBotWorkspaceDir(bot.id);
}

/** Map a normalized Bot to its compact list representation. */
export function toBotSummary(bot: NormalizedBot): BotSummary {
  return {
    id: bot.id,
    isDefault: bot.isDefault,
    name: bot.name,
    avatar: bot.avatar,
    description: bot.description,
    defaultModel: bot.defaultModel,
    defaultEffort: bot.defaultEffort,
    defaultProjectId: bot.defaultProjectId,
    defaultApprovalPolicy: bot.defaultApprovalPolicy,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
  };
}

/** Map a normalized Bot to its safe API detail view (plaintext `env` masked to `envKeys`). */
export function toBotDetail(bot: NormalizedBot): BotDetail {
  return {
    ...toBotSummary(bot),
    instructions: bot.instructions,
    toolGroups: bot.toolGroups,
    sandbox: bot.sandbox,
    skills: bot.skills,
    mcp: bot.mcp,
    includeGlobalContext: bot.includeGlobalContext,
    compaction: bot.compaction,
    envKeys: Object.keys(bot.env).toSorted(),
    homeDir: getBotHomeDir(bot.id),
    workspaceDir: resolveBotWorkspaceDir(bot),
    skillsDir: getBotSkillsDir(bot.id),
  };
}

/**
 * Resolve a Bot-private stdio MCP server with default Bot workspace cwd and
 * merged Bot environment variables (server-specific env takes precedence).
 */
export function resolveBotStdioServer(
  server: McpServerConfig,
  bot: NormalizedBot
): McpServerConfig {
  if (server.transport.type !== "stdio") {
    return server;
  }

  return {
    ...server,
    transport: {
      ...server.transport,
      cwd: server.transport.cwd ?? resolveBotWorkspaceDir(bot),
      env: { ...bot.env, ...server.transport.env },
    },
  };
}

/** Compute the effective MCP server list for a Bot (inherited globals + resolved private servers). */
export function resolveEffectiveMcpServers(
  bot: NormalizedBot,
  globalServers: readonly McpServerConfig[]
): McpServerConfig[] {
  const inherited = selectInheritedGlobalMcpServers(bot.mcp, globalServers);

  const privates = bot.mcp.servers.map((server) =>
    resolveBotStdioServer(server, bot)
  );
  return [...inherited, ...privates];
}

/** Ensure the built-in Default Bot row exists in the database and return it. */
export async function ensureDefaultBot(): Promise<NormalizedBot> {
  const existing = await findBotById(DEFAULT_BOT_ID);
  if (existing) {
    return normalizeBotRow(existing);
  }

  const inserted = await insertBot({
    id: DEFAULT_BOT_ID,
    name: DEFAULT_BOT_NAME,
    defaultApprovalPolicy: DEFAULT_APPROVAL_POLICY,
    toolGroups: { ...DEFAULT_BOT_TOOL_GROUPS },
    sandbox: { ...DEFAULT_BOT_SANDBOX_CONFIG },
    env: {},
    skills: { globalMode: "all", globalNames: [] },
    mcp: { globalMode: "all", globalServerIds: [], servers: [] },
    includeGlobalContext: true,
  });

  return normalizeBotRow(inserted);
}

/** Load an active Bot for session assembly or execution, ensuring Default Bot exists. */
export async function resolveBotForRun(
  botId: string = DEFAULT_BOT_ID
): Promise<NormalizedBot> {
  if (botId === DEFAULT_BOT_ID) {
    return await ensureDefaultBot();
  }

  const row = await findBotById(botId);
  if (!row) {
    throw new ApiError("BOT_NOT_FOUND", { data: { botId } });
  }
  return normalizeBotRow(row);
}

async function assertProjectExistsIfSet(
  projectId: string | null | undefined
): Promise<void> {
  if (typeof projectId !== "string" || projectId.length === 0) {
    return;
  }
  const project = await findProjectById(projectId);
  if (!project) {
    throw new ApiError("PROJECT_NOT_FOUND", { data: { projectId } });
  }
}

function emptyToNull(
  value: string | null | undefined
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function mcpServersDiffer(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export async function listBots(): Promise<BotSummary[]> {
  await ensureDefaultBot();
  const rows = await listActiveBots();
  return rows.map((row) => toBotSummary(normalizeBotRow(row)));
}

export async function getBot(botId: string): Promise<BotDetail> {
  const bot = await resolveBotForRun(botId);
  ensureBotDirs(bot.id, { isolateHome: bot.sandbox.isolateHome });
  return toBotDetail(bot);
}

export async function createBot(input: CreateBotInput): Promise<BotDetail> {
  await assertProjectExistsIfSet(input.defaultProjectId);

  const settings = await getUserSettings();
  const activeRows = await listActiveBots();
  const activeBots = activeRows.map(normalizeBotRow);

  const mcp = input.mcp ?? { ...DEFAULT_BOT_MCP_CONFIG };
  assertUniqueMcpAcrossGlobalAndBots({
    globalServers: settings.mcpServers,
    bots: [...activeBots, { id: "new-bot", mcp }],
  });

  const toolGroups = normalizeToolGroups(input.toolGroups);
  const sandbox = input.sandbox ?? { ...DEFAULT_BOT_SANDBOX_CONFIG };
  const skills = input.skills ?? { ...DEFAULT_BOT_SKILLS_CONFIG };
  const id = randomUUID();

  const row = await insertBot({
    id,
    name: input.name.trim(),
    avatar: emptyToNull(input.avatar) ?? null,
    description: emptyToNull(input.description) ?? null,
    instructions: emptyToNull(input.instructions) ?? null,
    defaultModel: input.defaultModel ?? null,
    defaultEffort: input.defaultEffort ?? null,
    defaultProjectId: input.defaultProjectId ?? null,
    defaultApprovalPolicy:
      input.defaultApprovalPolicy ?? DEFAULT_APPROVAL_POLICY,
    includeGlobalContext: input.includeGlobalContext ?? false,
    skills,
    mcp,
    toolGroups,
    sandbox,
    compaction: input.compaction ?? null,
    env: input.env ?? {},
  });

  const normalized = normalizeBotRow(row);
  ensureBotDirs(normalized.id, { isolateHome: normalized.sandbox.isolateHome });
  return toBotDetail(normalized);
}

export async function updateBot(input: UpdateBotInput): Promise<BotDetail> {
  const current = await resolveBotForRun(input.botId);

  if (input.defaultProjectId !== undefined) {
    await assertProjectExistsIfSet(input.defaultProjectId);
  }

  let nextMcp = current.mcp;
  if (input.mcp !== undefined) {
    const settings = await getUserSettings();
    const activeRows = await listActiveBots();
    const activeBots = activeRows.map(normalizeBotRow);
    nextMcp = input.mcp;
    assertUniqueMcpAcrossGlobalAndBots({
      globalServers: settings.mcpServers,
      bots: activeBots.map((bot) =>
        bot.id === current.id ? { id: bot.id, mcp: nextMcp } : bot
      ),
    });
  }

  let nextEnv = current.env;
  let envChanged = false;
  if (input.envPatch !== undefined) {
    const envMap = new Map(Object.entries(current.env));
    for (const [key, value] of Object.entries(input.envPatch)) {
      if (value === null) {
        if (envMap.delete(key)) {
          envChanged = true;
        }
      } else if (envMap.get(key) !== value) {
        envMap.set(key, value);
        envChanged = true;
      }
    }
    nextEnv = Object.fromEntries(envMap);
  }

  const nextToolGroups =
    input.toolGroups !== undefined
      ? normalizeToolGroups(input.toolGroups)
      : current.toolGroups;
  const nextSandbox = input.sandbox ?? current.sandbox;

  const updated = await updateBotRow(current.id, {
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...(input.avatar === undefined
      ? {}
      : { avatar: emptyToNull(input.avatar) ?? null }),
    ...(input.description === undefined
      ? {}
      : { description: emptyToNull(input.description) ?? null }),
    ...(input.instructions === undefined
      ? {}
      : { instructions: emptyToNull(input.instructions) ?? null }),
    ...(input.defaultModel === undefined
      ? {}
      : { defaultModel: input.defaultModel }),
    ...(input.defaultEffort === undefined
      ? {}
      : { defaultEffort: input.defaultEffort }),
    ...(input.defaultProjectId === undefined
      ? {}
      : { defaultProjectId: input.defaultProjectId }),
    ...(input.defaultApprovalPolicy === undefined
      ? {}
      : { defaultApprovalPolicy: input.defaultApprovalPolicy }),
    ...(input.includeGlobalContext === undefined
      ? {}
      : { includeGlobalContext: input.includeGlobalContext }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.mcp === undefined ? {} : { mcp: nextMcp }),
    ...(input.toolGroups === undefined ? {} : { toolGroups: nextToolGroups }),
    ...(input.sandbox === undefined ? {} : { sandbox: nextSandbox }),
    ...(input.compaction === undefined ? {} : { compaction: input.compaction }),
    ...(input.envPatch === undefined ? {} : { env: nextEnv }),
  });

  if (!updated) {
    throw new ApiError("BOT_NOT_FOUND", { data: { botId: input.botId } });
  }

  const normalized = normalizeBotRow(updated);
  ensureBotDirs(normalized.id, { isolateHome: normalized.sandbox.isolateHome });

  const mcpManager = getMcpManager();
  if (input.mcp !== undefined) {
    const dropped = await dropStaleMcpCredentials(
      current.mcp.servers,
      normalized.mcp.servers
    );
    for (const id of dropped) {
      mcpAuthorizationFlows.forget(id);
    }

    const nextById = new Map(
      normalized.mcp.servers.map((server) => [server.id, server])
    );
    for (const prev of current.mcp.servers) {
      const nextServer = nextById.get(prev.id);
      if (!nextServer) {
        await mcpManager.removeServer(prev.id);
      } else if (mcpServersDiffer(prev, nextServer)) {
        mcpManager.invalidateServer(prev.id);
      }
    }
  }

  if (envChanged) {
    for (const server of normalized.mcp.servers) {
      if (server.transport.type === "stdio") {
        mcpManager.invalidateServer(server.id);
      }
    }
  }

  return toBotDetail(normalized);
}

/** List private Bot skills and host global skills for the Bot configuration screen. */
export async function listBotSkills(botId: string): Promise<{
  botSkills: SkillInfo[];
  globalSkills: SkillInfo[];
  skillsDir: string;
  homeDir: string;
}> {
  const bot = await resolveBotForRun(botId);
  const dirs = ensureBotDirs(bot.id, { isolateHome: bot.sandbox.isolateHome });

  const botManager = new SkillManager({ dirs: SKILL_DIRS });
  const globalManager = new SkillManager({ dirs: SKILL_DIRS });

  await Promise.all([
    botManager.loadSkills({
      projectDir: dirs.workspaceDir,
      botSkillsDir: dirs.skillsDir,
      scanProject: false,
      globalMode: "none",
    }),
    globalManager.loadSkills({
      projectDir: dirs.workspaceDir,
      scanProject: false,
      globalMode: "all",
    }),
  ]);

  return {
    botSkills: botManager.listUserAvailableSkills(),
    globalSkills: globalManager.listUserAvailableSkills(),
    skillsDir: dirs.skillsDir,
    homeDir: dirs.homeDir,
  };
}

/** Return runtime status + OAuth authorization state for global and Bot-private MCP servers. */
export async function getBotMcpStatuses(botId: string) {
  const bot = await resolveBotForRun(botId);
  const settings = await getUserSettings();
  const resolvedPrivate = bot.mcp.servers.map((server) =>
    resolveBotStdioServer(server, bot)
  );

  const manager = getMcpManager();
  const privateRows = manager.statuses(resolvedPrivate);
  const globalRows = manager.statuses(settings.mcpServers);

  const [privateServers, globalServers] = await Promise.all([
    Promise.all(
      privateRows.map(async (row) => ({
        ...row,
        authorized: await hasMcpTokens(row.id),
      }))
    ),
    Promise.all(
      globalRows.map(async (row) => ({
        ...row,
        authorized: await hasMcpTokens(row.id),
      }))
    ),
  ]);

  return { privateServers, globalServers };
}

/** Test connecting a candidate private MCP server in the Bot's runtime environment. */
export async function testBotMcp(botId: string, server: McpServerConfig) {
  const bot = await resolveBotForRun(botId);
  ensureBotDirs(bot.id, { isolateHome: bot.sandbox.isolateHome });
  const resolved = resolveBotStdioServer(server, bot);
  return await getMcpManager().test(resolved);
}

/** Find a Bot-private MCP server by ID across all active Bots (used by `mcp.authorize`/`revoke`). */
export async function findActiveBotMcpServer(
  serverId: string
): Promise<McpServerConfig | undefined> {
  const rows = await listActiveBots();
  for (const row of rows) {
    const bot = normalizeBotRow(row);
    const match = bot.mcp.servers.find((server) => server.id === serverId);
    if (match) {
      return resolveBotStdioServer(match, bot);
    }
  }
  return undefined;
}
