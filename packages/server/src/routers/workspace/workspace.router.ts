/**
 * 工作区文件路由：列目录、取元数据、按行读文本。
 *
 * 三个过程都只读，没有写、删、改名和移动。字节内容不进 RPC，走
 * `GET /api/workspace/file`：浏览器要拿它做 `<img src>` 和下载。
 *
 * 会话到根的解析在 `workspace.service.ts`：它是这条链路上唯一读数据库的
 * 一步，终端会话也要用同一个根。`workspace.files.ts` 因此保持纯函数，测试
 * 可以直接构造根，不必建库。
 */
import { publicProcedure } from "../../index";
import {
  listEntries,
  readTextPage,
  statWorkspaceFile,
} from "./workspace.files";
import {
  listWorkspaceInput,
  readWorkspaceInput,
  statWorkspaceInput,
} from "./workspace.schema";
import { resolveSessionWorkspace } from "./workspace.service";

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
