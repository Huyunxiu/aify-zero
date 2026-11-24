import { rmSync } from "node:fs";
import { resolve, sep } from "node:path";

import { AgentRunnerError } from "@workspace/agent";
import { DEFAULT_BOT_ID } from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";

import { getBotHomeDir, getBotsRootDir } from "../../config";
import { ApiError } from "../../errors";
import { clearMcpCredentials } from "../../mcp/credentials";
import { mcpAuthorizationFlows } from "../../mcp/oauth";
import { getMcpManager } from "../../mcp/registry";
import { agentRunner } from "../../runtime";
import { releaseSessionSandbox } from "../../sandbox/registry";
import { SQLiteStore } from "../../storage/sqlite-store";
import { findBotById, softDeleteBotRow } from "./bot.repository";
import { normalizeBotRow } from "./bot.service";

/**
 * Delete a custom Bot after verifying none of its non-deleted sessions are busy.
 *
 * Kept separate from `bot.service.ts` to keep `runtime.ts` -> `session/agent.ts` -> `bot.service.ts`
 * acyclic cleanly without runtime importing deletion orchestration.
 */
export async function deleteBot(input: {
  botId: string;
  deleteFiles?: boolean;
}): Promise<{ botId: string; deleted: boolean; deletedSessionIds: string[] }> {
  const { botId, deleteFiles } = input;
  if (botId === DEFAULT_BOT_ID) {
    throw new ApiError("CANNOT_DELETE_DEFAULT_BOT", { data: { botId } });
  }

  const row = await findBotById(botId);
  if (!row) {
    throw new ApiError("BOT_NOT_FOUND", { data: { botId } });
  }

  const bot = normalizeBotRow(row);
  const store = new SQLiteStore();
  const sessions = await store.listSessionsByBotId(botId);

  for (const session of sessions) {
    if (
      agentRunner.isSessionBusy(session.id) ||
      session.activeStreamId !== null ||
      session.status === "running" ||
      session.status === "wait_review"
    ) {
      throw new ApiError("BOT_BUSY", {
        data: { botId, sessionId: session.id },
      });
    }
  }

  const deletedSessionIds = new Set<string>();
  const mainFirst = [
    ...sessions.filter((session) => session.kind === "main"),
    ...sessions.filter((session) => session.kind !== "main"),
  ];

  for (const session of mainFirst) {
    if (deletedSessionIds.has(session.id)) {
      continue;
    }

    try {
      const result = await agentRunner.delete(session.id);
      for (const id of result.sessionIds) {
        deletedSessionIds.add(id);
        await releaseSessionSandbox(id).catch((error: unknown) => {
          logger.warn("[bot] failed to release session sandbox", error);
        });
      }
    } catch (error) {
      if (error instanceof AgentRunnerError && error.code === "SESSION_BUSY") {
        throw new ApiError("BOT_BUSY", {
          data: { botId, sessionId: session.id },
        });
      }
      throw error;
    }
  }

  await softDeleteBotRow(botId, new Date());

  const mcpManager = getMcpManager();
  for (const server of bot.mcp.servers) {
    await clearMcpCredentials(server.id);
    mcpAuthorizationFlows.forget(server.id);
    await mcpManager.removeServer(server.id);
  }

  if (deleteFiles === true) {
    const botsRoot = resolve(getBotsRootDir());
    const homeDir = resolve(getBotHomeDir(botId));
    if (homeDir.startsWith(`${botsRoot}${sep}`)) {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }

  return {
    botId,
    deleted: true,
    deletedSessionIds: [...deletedSessionIds],
  };
}
