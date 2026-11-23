import type { McpServerConfig } from "@workspace/agent";
import type { BotMcpConfig } from "@workspace/agent-client";
import { findMcpServerProblems } from "@workspace/agent/mcp";

import { ApiError } from "../errors";

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

    const inheritedGlobals =
      bot.mcp.globalMode === "all"
        ? input.globalServers
        : input.globalServers.filter((server) =>
            bot.mcp.globalServerIds.includes(server.id)
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
