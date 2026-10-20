import type { ContextFile } from "../context-files";
import type { SkillInfo } from "../skill/skill-types";

/**
 * 加载资源时能拿到的环境。
 *
 * `workdir` 给文件系统源用；`userId` / `projectId` 留给以后接入数据库时
 * 做租户过滤，文件系统源会忽略它们。
 */
export type ResourceLoadContext = {
  workdir: string;
  userId?: string;
  projectId?: string;
};

export interface SkillSource {
  load(context: ResourceLoadContext): Promise<SkillInfo[]>;
}

export interface ContextSource {
  load(context: ResourceLoadContext): Promise<ContextFile[]>;
}
