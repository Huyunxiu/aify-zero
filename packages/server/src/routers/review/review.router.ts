/**
 * 改动视图的路由：列出改动、读一个改动两侧的文本。
 *
 * 两个过程都只读。会话到主目录的解析在 `review.service.ts` 之前完成，和
 * 工作区文件路由用同一个根。
 */
import { publicProcedure } from "../../index";
import { resolveSessionWorkspace } from "../workspace/workspace.service";
import { reviewChangesInput, reviewFileInput } from "./review.schema";
import { readReviewChanges, readReviewFile } from "./review.service";

// GET /review/changes — 主目录里相对基线有改动的路径
const changes = publicProcedure
  .route({ method: "GET", path: "/review/changes" })
  .input(reviewChangesInput)
  .handler(async ({ input }) => {
    const workspace = await resolveSessionWorkspace(input.sessionId);
    return await readReviewChanges(workspace);
  });

// GET /review/file — 一个改动两侧的文本
const file = publicProcedure
  .route({ method: "GET", path: "/review/file" })
  .input(reviewFileInput)
  .handler(async ({ input }) => {
    const workspace = await resolveSessionWorkspace(input.sessionId);
    return await readReviewFile(workspace, input.path);
  });

export const review = { changes, file };
