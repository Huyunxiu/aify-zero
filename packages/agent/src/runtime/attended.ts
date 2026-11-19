import type { InboxItem } from "@workspace/agent-client";

/**
 * 这一次运行有没有人在场。
 *
 * 只有用户发来的待办项才算在场：定时器到点和后台任务的完成通知都是没人看着
 * 的时候发生的，它们唤起的运行要按更严的策略装配。审批答复触发的运行不走
 * 收件箱，默认算在场。
 */
export function isAttendedRun(items: readonly InboxItem[]): boolean {
  return items.some((item) => item.kind === "user-message");
}
