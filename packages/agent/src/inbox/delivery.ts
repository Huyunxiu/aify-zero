import type { DeliverAt } from "@workspace/agent-client";

/** 发送者希望这条待办项怎么交付。 */
export type InboxMode = "steering" | "followup";

/**
 * 一条待办项最早能在哪个边界交进去。
 *
 * 只有「普通回合正在运行 + steering」才落在 `step-boundary`；空闲、等待审批、
 * 手工压缩都只能排到 `run-boundary`。
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
