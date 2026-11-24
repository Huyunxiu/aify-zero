import {
  FileSystemContextSource,
  FileSystemSkillSource,
} from "@workspace/agent";
import type { SkillScanOptions } from "@workspace/agent/skill";

import { ensureBotDirs } from "../config";
import {
  resolveBotForRun,
  resolveBotWorkspaceDir,
} from "../routers/bot/bot.service";
import type { NormalizedBot } from "../routers/bot/bot.service";
import { getProjectDirs } from "../routers/project/project.service";

export interface SessionDirectoryResolution {
  bot: NormalizedBot;
  botHomeDir: string;
  botWorkspaceDir: string;
  botSkillsDir: string;
  botIsolatedHomeDir?: string;
  /** Primary working directory for tools, review baseline, and terminal cwd. */
  primaryDir: string;
  /** All mounted workspace roots ordered primary-first, with Bot Workspace included cleanly. */
  projectDirs: [string, ...string[]];
  /** True when a Project is attached to the session; false when running in Bot Workspace directly. */
  hasProject: boolean;
}

/** Deduplicate directories preserving the first appearance order. */
function dedupeDirs(dirs: readonly string[]): [string, ...string[]] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const dir of dirs) {
    if (!seen.has(dir)) {
      seen.add(dir);
      unique.push(dir);
    }
  }
  const [first, ...rest] = unique;
  if (first === undefined) {
    throw new Error("At least one directory is required.");
  }
  return [first, ...rest];
}

/**
 * Single authoritative resolver for Bot and Project session directories.
 *
 * Used by session agent assembly, workspace file routes, terminal cwd, review baseline,
 * and session resource listing so all surfaces agree on accessible directories.
 */
export async function resolveSessionDirectories(input: {
  botId?: string;
  projectId?: string;
}): Promise<SessionDirectoryResolution> {
  const bot = await resolveBotForRun(input.botId);
  const dirs = ensureBotDirs(bot.id, {
    isolateHome: bot.sandbox.isolateHome,
  });
  const botWorkspaceDir = resolveBotWorkspaceDir(bot);

  if (input.projectId) {
    const projectDirs = await getProjectDirs(input.projectId);
    const [primaryDir] = projectDirs;
    return {
      bot,
      botHomeDir: dirs.homeDir,
      botWorkspaceDir,
      botSkillsDir: dirs.skillsDir,
      ...(bot.sandbox.isolateHome
        ? { botIsolatedHomeDir: dirs.isolatedHomeDir }
        : {}),
      primaryDir,
      projectDirs: dedupeDirs([...projectDirs, botWorkspaceDir]),
      hasProject: true,
    };
  }

  return {
    bot,
    botHomeDir: dirs.homeDir,
    botWorkspaceDir,
    botSkillsDir: dirs.skillsDir,
    ...(bot.sandbox.isolateHome
      ? { botIsolatedHomeDir: dirs.isolatedHomeDir }
      : {}),
    primaryDir: botWorkspaceDir,
    projectDirs: [botWorkspaceDir],
    hasProject: false,
  };
}

/**
 * The Bot scope that a session's skills resolve against. Both the loader options
 * and the file system source read it here, so the mapping is stated once.
 */
function botSkillScope(dirs: SessionDirectoryResolution) {
  return {
    botSkillsDir: dirs.botSkillsDir,
    scanProject: dirs.hasProject,
    globalMode: dirs.bot.skills.globalMode,
    globalNames: dirs.bot.skills.globalNames,
  };
}

/** Build Bot-scoped skill loading options for `SkillManager.loadSkills`. */
export function buildBotSkillLoadOptions(
  dirs: SessionDirectoryResolution
): SkillScanOptions {
  return { projectDir: dirs.primaryDir, ...botSkillScope(dirs) };
}

/** Create the filesystem skill source matching a Bot session's directory scope. */
export function createBotSkillSource(
  dirs: SessionDirectoryResolution
): FileSystemSkillSource {
  return new FileSystemSkillSource(botSkillScope(dirs));
}

/** Create the filesystem context source matching a Bot session's inheritance rules. */
export function createBotContextSource(
  dirs: SessionDirectoryResolution
): FileSystemContextSource {
  return new FileSystemContextSource({
    globalDirs: dirs.bot.includeGlobalContext ? undefined : [],
    botHomeDir: dirs.botHomeDir,
    scanProject: dirs.hasProject,
  });
}
