/**
 * 工作区文件路由：列目录、取元数据、按行读文本。
 *
 * 三个过程都只读，没有写、删、改名和移动。字节内容不进 RPC，走
 * `GET /api/workspace/file`：浏览器要拿它做 `<img src>` 和下载。
 *
 * 会话到根的解析放在这里，因为它是这条链路上唯一读数据库的一步。
 * `workspace.files.ts` 因此保持纯函数，测试可以直接构造根，不必建库。
 */
import { getSessionDir } from "../../config";
import { ApiError } from "../../errors";
import { publicProcedure } from "../../index";
import { SQLiteStore } from "../../storage/sqlite-store";
import { getProjectDirs } from "../project/project.service";
import {
  listEntries,
  readTextPage,
  statWorkspaceFile,
} from "./workspace.files";
import type { WorkspaceRoots } from "./workspace.paths";
import {
  listWorkspaceInput,
  readWorkspaceInput,
  statWorkspaceInput,
} from "./workspace.schema";

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

// GET /workspace/entries — 列一个目录的直接子项
const list = publicProcedure
  .route({ method: "GET", path: "/workspace/entries" })
  .input(listWorkspaceInput)
  .handler(async ({ input }) => {
    const workspace = await resolveSessionWorkspace(input.sessionId);
    return await listEntries(workspace, input.path);
  });

// GET /workspace/stat — 一个文件的路径、版本、字节数
const stat = publicProcedure
  .route({ method: "GET", path: "/workspace/stat" })
  .input(statWorkspaceInput)
  .handler(async ({ input }) => {
    const workspace = await resolveSessionWorkspace(input.sessionId);
    return await statWorkspaceFile(workspace, input.path);
  });

// GET /workspace/read — 按行分页读 UTF-8 文本
const read = publicProcedure
  .route({ method: "GET", path: "/workspace/read" })
  .input(readWorkspaceInput)
  .handler(async ({ input, context }) => {
    const workspace = await resolveSessionWorkspace(input.sessionId);
    return await readTextPage(
      workspace,
      input.path,
      { offset: input.offset, limit: input.limit },
      { signal: context.signal }
    );
  });

export const workspace = { list, read, stat };
