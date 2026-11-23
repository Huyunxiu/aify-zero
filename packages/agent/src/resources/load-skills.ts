import type { BotGlobalSkillsMode } from "@workspace/agent-client";
import { logger } from "@workspace/shared/logger";

import { SKILL_DIRS, SkillManager } from "../skill/skill-manager";
import type { SkillInfo } from "../skill/skill-types";
import type { ResourceLoadContext, SkillSource } from "./types";

/**
 * 依次加载所有技能源。
 *
 * 单个源失败只记日志，不拖垮其他源。成功返回的技能按 source 顺序写入
 * `priority`（数值越小越强）；数据源显式提供的值优先，用来让数据库记录
 * 排到文件系统前面。
 */
export async function loadSkills(
  sources: readonly SkillSource[],
  context: ResourceLoadContext
): Promise<SkillInfo[]> {
  const results = await Promise.allSettled(
    sources.map((source) => source.load(context))
  );

  const skills: SkillInfo[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      logger.warn(
        `[resources] skill source ${index} failed to load`,
        result.reason
      );
      continue;
    }
    for (const skill of result.value) {
      skills.push({ ...skill, priority: skill.priority ?? index });
    }
  }

  return skills;
}

export type FileSystemSkillSourceOptions = {
  dirs?: readonly string[];
  botSkillsDir?: string;
  scanProject?: boolean;
  globalMode?: BotGlobalSkillsMode;
  globalNames?: readonly string[];
};

/** 从文件系统加载技能，包住现有的 `SkillManager.scan`。 */
export class FileSystemSkillSource implements SkillSource {
  readonly #options: FileSystemSkillSourceOptions;

  constructor(options: FileSystemSkillSourceOptions = {}) {
    this.#options = options;
  }

  load(context: ResourceLoadContext): Promise<SkillInfo[]> {
    const manager = new SkillManager({
      dirs: this.#options.dirs ?? SKILL_DIRS,
    });
    return manager.scan({
      projectDir: context.projectDir,
      scanProject: this.#options.scanProject,
      botSkillsDir: this.#options.botSkillsDir,
      globalMode: this.#options.globalMode,
      globalNames: this.#options.globalNames,
    });
  }
}
