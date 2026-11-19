import { APPROVAL_POLICIES } from "@workspace/agent-client";
import z from "zod";

export const listSessionTurnsSchema = z.object({
  sessionId: z.string(),
});

export const forkSessionSchema = z.object({
  sessionId: z.string(),
  messageId: z.string().optional(),
});

export type ForkSessionType = z.infer<typeof forkSessionSchema>;

/** 审批策略的值域；数据库那列是 text，靠这里守。 */
export const approvalPolicySchema = z.enum(APPROVAL_POLICIES);

export const inboxItemIdSchema = z.object({
  sessionId: z.string(),
  itemId: z.string(),
});
