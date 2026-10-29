import type { AgentStreamEvent } from "@workspace/agent-client";

import type { AgentToolSet } from "../types";

/**
 * 哪些事件需要把 step 快照写进 `step` 表。
 *
 * 只覆盖“step 到达终态、或终态 step 被再次修改”的事件：
 *
 * - `step.finish`：step 结束，写第一份完整快照；
 * - `step.metadata`：审批恢复后补回工具执行耗时；
 * - `tool.output-denied`：拒绝结果会改已结束的 step，且之后没有 `step.finish`。
 *
 * 文本和工具输入的增量事件不写库：它们的最终内容由 `step.finish` 覆盖，逐
 * delta 写会把一次 step 变成几十次 JSON 更新。
 */
export function journaledStepTarget(
  event: AgentStreamEvent<AgentToolSet>
): { turnId: string; stepId: string } | undefined {
  if (
    event.type === "step.finish" ||
    event.type === "step.metadata" ||
    event.type === "tool.output-denied"
  ) {
    return { turnId: event.turnId, stepId: event.stepId };
  }

  return undefined;
}
