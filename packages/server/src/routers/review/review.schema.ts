/**
 * 评审接口的输入。
 *
 * 两个过程都以会话 id 开始：它决定在哪个目录里找仓库。单个文件的路径相对
 * 主目录，服务层还会再校验一次。
 */
import z from "zod";

/** 列改动：只认会话。 */
export const reviewChangesInput = z.object({
  sessionId: z.string().min(1),
});

/** 读一个改动：会话加路径。 */
export const reviewFileInput = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
});
