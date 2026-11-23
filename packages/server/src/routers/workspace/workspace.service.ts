/**
 * Session-to-workspace root resolution shared across workspace file routes,
 * terminal sessions, and review diff routes.
 */
import { getSessionDir } from "../../config";
import { ApiError } from "../../errors";
import { resolveSessionDirectories } from "../../session/directories";
import { SQLiteStore } from "../../storage/sqlite-store";
import type { WorkspaceRoots } from "./workspace.paths";

/**
 * Resolve accessible workspace roots for one session.
 *
 * Delegates to {@link resolveSessionDirectories} so Project directories,
 * Bot Workspace, and session directory stay consistent across agent tools,
 * file browser, terminal, and review view.
 */
export async function resolveSessionWorkspace(
  sessionId: string
): Promise<WorkspaceRoots> {
  const session = await new SQLiteStore().getSessionById(sessionId);
  if (session === null) {
    throw new ApiError("SESSION_NOT_FOUND", { data: { sessionId } });
  }

  const resolved = await resolveSessionDirectories({
    botId: session.botId,
    projectId: session.projectId ?? undefined,
  });

  return {
    primaryDir: resolved.primaryDir,
    roots: [...resolved.projectDirs, getSessionDir(sessionId)],
  };
}
