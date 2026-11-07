/**
 * 会话到工作区根的解析。
 *
 * 文件路由和终端会话都从这里取同一个根：相对路径以 `primaryDir` 为基准，
 * 终端也在这个目录里启动 shell。把它单独放一层，是为了让不经过 RPC 的调用方
 * （例如 `/api/terminal` 升级）不必加载 oRPC 路由。
 */
import { getSessionDir } from "../../config";
import { ApiError } from "../../errors";
import { SQLiteStore } from "../../storage/sqlite-store";
import { getProjectDirs } from "../project/project.service";
import type { WorkspaceRoots } from "./workspace.paths";

/**
 * 解析一个会话可访问的根。
 *
 * 两个来源：项目目录（`session.projectId` → `getProjectDirs`）和会话私有
 * 目录（`~/.aify-zero/sessions/<id>`）。会话目录放进来，是为了让会话产出的
 * 临时文件和 artifact 也能在界面上预览。项目为空时沿用 `getProjectDirs`
 * 的家目录兜底，与 agent 的可见范围一致。
 *
 * @param sessionId - 会话 id；不存在时按 `SESSION_NOT_FOUND` 拒绝。
 */
export async function resolveSessionWorkspace(
  sessionId: string
): Promise<WorkspaceRoots> {
  const session = await new SQLiteStore().getSessionById(sessionId);
  if (session === null) {
    throw new ApiError("SESSION_NOT_FOUND", { data: { sessionId } });
  }

  const projectDirs = await getProjectDirs(session.projectId ?? undefined);
  const [primaryDir] = projectDirs;

  return { primaryDir, roots: [...projectDirs, getSessionDir(sessionId)] };
}
