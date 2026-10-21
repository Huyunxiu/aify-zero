import { homedir } from "node:os";

import { ApiError } from "../../errors";
import { findProjectById } from "./project.repository";

/**
 * agent 可访问的项目目录，第一项是主目录。
 *
 * 顺序就是 `AgentContext.projectDirs` 的约定：primary 在最前，其余目录只能
 * 通过绝对路径访问。project 表为空时退回用户家目录，保证 agent 始终有一个
 * 可写的工作根，而不是启动失败。
 */
export async function getProjectDirs(
  projectId?: string
): Promise<[string, ...string[]]> {
  if (projectId) {
    const project = await findProjectById(projectId);
    // 传了 id 却查不到时不能悄悄换一个目录继续跑：调用方以为在 A 项目，
    // 实际会写进 B。
    if (!project) {
      throw new ApiError("PROJECT_NOT_FOUND", { data: { projectId } });
    }
    return [project.primaryDir, ...project.additionalDirs];
  }

  return [homedir()];
}

/** 主目录，即 `getProjectDirs` 的第一项。 */
export async function getPrimaryProjectDir(
  projectId?: string
): Promise<string> {
  const [primary] = await getProjectDirs(projectId);
  return primary;
}
