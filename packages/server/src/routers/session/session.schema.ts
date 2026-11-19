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

/** The values of the Approval Policy. The database column is text, so this check guards it. */
export const approvalPolicySchema = z.enum(APPROVAL_POLICIES);

export const inboxItemIdSchema = z.object({
  sessionId: z.string(),
  itemId: z.string(),
});
