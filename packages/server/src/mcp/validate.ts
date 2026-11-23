import type { McpServerConfig } from "@workspace/agent";
import {
  botMcpConfigSchema,
  DEFAULT_BOT_MCP_CONFIG,
} from "@workspace/agent-client";
import type { BotMcpConfig } from "@workspace/agent-client";
import { findMcpServerProblems } from "@workspace/agent/mcp";

import { ApiError } from "../errors";

/** Parse stored JSON into a valid Bot MCP configuration with canonical defaults. */
export function parseBotMcpConfig(raw: unknown): BotMcpConfig {
  const parsed = botMcpConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...DEFAULT_BOT_MCP_CONFIG };
}

/** Return the global MCP servers inherited by a Bot under its `globalMode` rule. */
export function selectInheritedGlobalMcpServers(
  botMcp: Pick<BotMcpConfig, "globalMode" | "globalServerIds">,
  globalServers: readonly McpServerConfig[]
): McpServerConfig[] {
  return botMcp.globalMode === "all"
    ? [...globalServers]
    : globalServers.filter((server) =>
        botMcp.globalServerIds.includes(server.id)
      );
}

/**
 * Reject overlapping MCP server configurations before saving.
 *
 * Server names form tool name prefixes, so duplicates overwrite tools; duplicate
 * ids fight over the same connection slot in `McpManager`.
 */
export function assertUniqueMcpServers(
  servers: readonly McpServerConfig[]
): void {
  const [problem] = findMcpServerProblems(servers);
  if (!problem) {
    return;
  }

  throw new ApiError("MCP_SERVER_DUPLICATE", {
    data: {
      kind: problem.kind,
      value: problem.kind === "duplicate-id" ? problem.id : problem.name,
    },
  });
}

export interface BotMcpValidationTarget {
  readonly id: string;
  readonly mcp: Pick<
    BotMcpConfig,
    "globalMode" | "globalServerIds" | "servers"
  >;
}

/**
 * Ensure global and Bot-private MCP servers never share an `id`, and no Bot's
 * effective server set (inherited globals + private servers) contains duplicate names.
 */
export function assertUniqueMcpAcrossGlobalAndBots(input: {
  globalServers: readonly McpServerConfig[];
  bots: readonly BotMcpValidationTarget[];
}): void {
  assertUniqueMcpServers(input.globalServers);

  const seenIds = new Set(input.globalServers.map((server) => server.id));

  for (const bot of input.bots) {
    for (const server of bot.mcp.servers) {
      if (seenIds.has(server.id)) {
        throw new ApiError("MCP_SERVER_DUPLICATE", {
          data: { kind: "duplicate-id", value: server.id },
        });
      }
      seenIds.add(server.id);
    }

    const inheritedGlobals = selectInheritedGlobalMcpServers(
      bot.mcp,
      input.globalServers
    );

    const effective = [...inheritedGlobals, ...bot.mcp.servers];
    const [problem] = findMcpServerProblems(effective);
    if (problem) {
      throw new ApiError("MCP_SERVER_DUPLICATE", {
        data: {
          kind: problem.kind,
          value: problem.kind === "duplicate-id" ? problem.id : problem.name,
        },
      });
    }
  }
}
