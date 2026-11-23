import { MODEL_EFFORT_LABELS } from "@workspace/shared/constants";
import type { ModelEffort } from "@workspace/shared/constants";
import type { ModelRef } from "@workspace/shared/model";
import { z } from "zod";

import type { ApprovalPolicy } from "./approval-policy";
import { mcpServerSchema } from "./mcp-config";
import type { McpServerConfig } from "./mcp-config";

/** Built-in Default Bot identifier. Cannot be deleted. */
export const DEFAULT_BOT_ID = "default";

/** Canonical display name for the built-in Default Bot. */
export const DEFAULT_BOT_NAME = "Default Bot";

/** Built-in tool capability groups that a Bot can toggle independently. */
export const BOT_TOOL_GROUPS = [
  "files",
  "shell",
  "web",
  "jobs",
  "timers",
  "subagent",
] as const;

export type BotToolGroup = (typeof BOT_TOOL_GROUPS)[number];

export type BotToolGroups = Record<BotToolGroup, boolean>;

export const DEFAULT_BOT_TOOL_GROUPS: BotToolGroups = {
  files: true,
  shell: true,
  web: true,
  jobs: true,
  timers: true,
  subagent: true,
};

export const botToolGroupsSchema: z.ZodType<BotToolGroups> = z
  .object({
    files: z.boolean(),
    shell: z.boolean(),
    web: z.boolean(),
    jobs: z.boolean(),
    timers: z.boolean(),
    subagent: z.boolean(),
  })
  .strict();

/** Sandbox adapter choices stored on a Bot. `"inherit"` follows the server process default. */
export const BOT_SANDBOX_ADAPTERS = [
  "inherit",
  "host",
  "isolated",
  "apple-container",
] as const;

export type BotSandboxAdapterChoice = (typeof BOT_SANDBOX_ADAPTERS)[number];

export type BotSandboxConfig = {
  adapter: BotSandboxAdapterChoice;
  image?: string;
  isolateHome: boolean;
};

export const DEFAULT_BOT_SANDBOX_CONFIG: BotSandboxConfig = {
  adapter: "inherit",
  isolateHome: false,
};

export const botSandboxConfigSchema = z
  .object({
    adapter: z.enum(BOT_SANDBOX_ADAPTERS),
    image: z.string().trim().min(1).optional(),
    isolateHome: z.boolean(),
  })
  .strict();

/** How a Bot inherits host global skills (`~/.aify-studio`, `~/.agents`). */
export const BOT_GLOBAL_SKILLS_MODES = ["none", "all", "selected"] as const;

export type BotGlobalSkillsMode = (typeof BOT_GLOBAL_SKILLS_MODES)[number];

export type BotSkillsConfig = {
  globalMode: BotGlobalSkillsMode;
  globalNames: string[];
};

export const DEFAULT_BOT_SKILLS_CONFIG: BotSkillsConfig = {
  globalMode: "none",
  globalNames: [],
};

export const botSkillsConfigSchema = z
  .object({
    globalMode: z.enum(BOT_GLOBAL_SKILLS_MODES),
    globalNames: z.array(z.string().min(1)),
  })
  .strict();

/** How a Bot inherits global MCP servers from `user.settings`. */
export const BOT_GLOBAL_MCP_MODES = ["all", "selected"] as const;

export type BotGlobalMcpMode = (typeof BOT_GLOBAL_MCP_MODES)[number];

export type BotMcpConfig = {
  globalMode: BotGlobalMcpMode;
  globalServerIds: string[];
  servers: McpServerConfig[];
};

export const DEFAULT_BOT_MCP_CONFIG: BotMcpConfig = {
  globalMode: "selected",
  globalServerIds: [],
  servers: [],
};

export const botMcpConfigSchema = z
  .object({
    globalMode: z.enum(BOT_GLOBAL_MCP_MODES),
    globalServerIds: z.array(z.string().min(1)),
    servers: z.array(mcpServerSchema),
  })
  .strict();

export const botCompactionOverrideSchema = z
  .object({
    auto: z.boolean().optional(),
    thresholdRatio: z.number().min(0.5).max(0.95).optional(),
    reserveTokens: z.number().int().min(0).optional(),
    keepRecentTokens: z.number().int().min(0).optional(),
    pruneToolResults: z.boolean().optional(),
    maxSummaryTokens: z.number().int().min(256).optional(),
  })
  .strict();

export type BotCompactionOverride = z.infer<typeof botCompactionOverrideSchema>;

/** Authoritative default values used when compaction overrides are customized. */
export const DEFAULT_BOT_COMPACTION_OVERRIDE: Required<BotCompactionOverride> =
  {
    auto: true,
    thresholdRatio: 0.8,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    pruneToolResults: true,
    maxSummaryTokens: 8192,
  };

export const botModelRefSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
  })
  .strict();

export const botEffortSchema: z.ZodType<ModelEffort> = z.enum(
  MODEL_EFFORT_LABELS as [ModelEffort, ...ModelEffort[]]
);

/**
 * Shared Bot configuration fields persisted in SQLite (`bot` table).
 * Plaintext `env` values never leave the server; clients receive `envKeys` instead.
 */
export type BotConfig = {
  id: string;
  name: string;
  avatar: string | null;
  description: string | null;
  instructions: string | null;
  defaultModel: ModelRef | null;
  defaultEffort: ModelEffort | null;
  defaultProjectId: string | null;
  defaultApprovalPolicy: ApprovalPolicy;
  toolGroups: BotToolGroups;
  sandbox: BotSandboxConfig;
  skills: BotSkillsConfig;
  mcp: BotMcpConfig;
  includeGlobalContext: boolean;
  compaction: BotCompactionOverride | null;
};

/** Compact Bot representation returned in list endpoints and sidebar views. */
export type BotSummary = {
  id: string;
  isDefault: boolean;
  name: string;
  avatar: string | null;
  description: string | null;
  defaultModel: ModelRef | null;
  defaultEffort: ModelEffort | null;
  defaultProjectId: string | null;
  defaultApprovalPolicy: ApprovalPolicy;
  createdAt: number;
  updatedAt: number;
};

/** Full Bot detail returned to the configuration view and session assembly consumers. */
export type BotDetail = BotConfig &
  BotSummary & {
    envKeys: string[];
    homeDir: string;
    workspaceDir: string;
    skillsDir: string;
  };
