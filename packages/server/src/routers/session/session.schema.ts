import type { DeliverAt } from "@workspace/agent-client";
import z from "zod";

export const listSessionTurnsSchema = z.object({
  sessionId: z.string(),
});

export const forkSessionSchema = z.object({
  sessionId: z.string(),
  messageId: z.string().optional(),
});

export type ForkSessionType = z.infer<typeof forkSessionSchema>;

export const inboxItemIdSchema = z.object({
  sessionId: z.string(),
  itemId: z.string(),
});

export type InboxMode = "steering" | "followup";

/**
 * 一条待办项最早能在哪个边界交进去。
 *
 * 只有「普通回合正在运行 + steering」才落在 `step-boundary`；空闲、等待审批、
 * 手工压缩都只能排到 `run-boundary`。抽成纯函数，服务端 handler 和测试共用
 * 同一套判断。
 */
export function resolveDeliverAt(input: {
  mode: InboxMode;
  running: boolean;
  streamKind: "turn" | "compaction" | undefined;
}): DeliverAt {
  return input.mode === "steering" &&
    input.running &&
    input.streamKind === "turn"
    ? "step-boundary"
    : "run-boundary";
}
