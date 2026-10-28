import type { InboxPlacement } from "@workspace/agent-client";
import z from "zod";

export const listSessionTurnsSchema = z.object({
  sessionId: z.string(),
});

export const forkSessionSchema = z.object({
  sessionId: z.string(),
  messageId: z.string().optional(),
});

export type ForkSessionType = z.infer<typeof forkSessionSchema>;

export const inboxMessageIdSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
});

export type InboxMode = "steering" | "followup";

/**
 * 一条 Inbox 消息的投递位置。
 *
 * 只有“普通回合正在运行 + steering”才落在下一步；空闲、等待审批、手工压缩
 * 都只能排到下一回合。抽成纯函数，服务端 handler 和测试共用同一套判断。
 */
export function resolveInboxPlacement(input: {
  mode: InboxMode;
  running: boolean;
  streamKind: "turn" | "compaction" | undefined;
}): InboxPlacement {
  return input.mode === "steering" &&
    input.running &&
    input.streamKind === "turn"
    ? "next-step"
    : "next-turn";
}
