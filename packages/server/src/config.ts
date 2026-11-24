import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SAFE_BOT_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Root data directory: `AIFY_DATA_DIR` override or `~/.aify-zero`.
 *
 * Matches `@workspace/db`'s `resolveDatabaseUrl` default location.
 */
export function getDataDir(): string {
  const override = process.env.AIFY_DATA_DIR?.trim();
  return override !== undefined && override.length > 0
    ? override
    : join(homedir(), ".aify-zero");
}

/** Validate a Bot identifier before deriving filesystem paths from it. */
export function assertSafeBotId(botId: string): string {
  if (!SAFE_BOT_ID.test(botId)) {
    throw new Error(`Invalid bot id: "${botId}".`);
  }
  return botId;
}

/** Private session directory for temporary files and artifacts (`<dataDir>/sessions/<sessionId>`). */
export function getSessionDir(sessionId: string): string {
  return join(getDataDir(), "sessions", sessionId);
}

/** Root directory holding all Bot Home directories (`<dataDir>/bots`). */
export function getBotsRootDir(): string {
  return join(getDataDir(), "bots");
}

/** Bot Home directory holding file-based resources (`<dataDir>/bots/<botId>`). */
export function getBotHomeDir(botId: string): string {
  return join(getBotsRootDir(), assertSafeBotId(botId));
}

/** Built-in Bot Workspace directory (`<botHome>/workspace`). */
export function getBotWorkspaceDir(botId: string): string {
  return join(getBotHomeDir(botId), "workspace");
}

/** Bot private skills directory (`<botHome>/skills`). */
export function getBotSkillsDir(botId: string): string {
  return join(getBotHomeDir(botId), "skills");
}

/** Bot isolated HOME directory used when `sandbox.isolateHome` is enabled (`<botHome>/home`). */
export function getBotIsolatedHomeDir(botId: string): string {
  return join(getBotHomeDir(botId), "home");
}

/** Bot-owned assets (`<botHome>/assets`), served by `/api/asset?owner=bot:<id>`. */
export function getBotAssetsDir(botId: string): string {
  return join(getBotHomeDir(botId), "assets");
}

/** Session-owned assets (`<sessionDir>/assets`), served by `/api/asset?owner=session:<id>`. */
export function getSessionAssetsDir(sessionId: string): string {
  return join(getSessionDir(sessionId), "assets");
}

export interface EnsuredBotDirs {
  homeDir: string;
  workspaceDir: string;
  skillsDir: string;
  isolatedHomeDir: string;
}

/** Ensure Bot Home subdirectories exist on disk before a Run or resource scan reads them. */
export function ensureBotDirs(
  botId: string,
  options?: { isolateHome?: boolean }
): EnsuredBotDirs {
  const homeDir = getBotHomeDir(botId);
  const workspaceDir = getBotWorkspaceDir(botId);
  const skillsDir = getBotSkillsDir(botId);
  const isolatedHomeDir = getBotIsolatedHomeDir(botId);

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(getBotAssetsDir(botId), { recursive: true });
  if (options?.isolateHome) {
    mkdirSync(isolatedHomeDir, { recursive: true });
  }

  return { homeDir, workspaceDir, skillsDir, isolatedHomeDir };
}
