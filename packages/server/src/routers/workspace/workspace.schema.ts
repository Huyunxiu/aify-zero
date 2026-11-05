/**
 * 工作区文件接口的输入。
 *
 * 三个过程都以同一个目标开始：会话 id 决定可访问的根，路径可以是绝对路径，
 * 也可以是相对主目录的路径。上限从 `DEFAULT_LIMITS` 读，避免 schema 和
 * 服务层各写一份。
 */
import z from "zod";

import { DEFAULT_LIMITS } from "./workspace.files";

const sessionTarget = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
});

/** 列目录：只接受目标，分页由目录本身决定。 */
export const listWorkspaceInput = sessionTarget;

/** 取元数据：同上。 */
export const statWorkspaceInput = sessionTarget;

/** 读文本页：行窗口带默认值，上限与 `maxLines` 一致。 */
export const readWorkspaceInput = sessionTarget.extend({
  offset: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(DEFAULT_LIMITS.maxLines)
    .default(DEFAULT_LIMITS.maxLines),
});
