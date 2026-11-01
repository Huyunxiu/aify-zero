import { logger } from "@workspace/shared/logger";

import type { ToolCallHookEvent, ToolStartDecision } from "./hooks-manager";

/** 审批函数可以弃权：null 和 undefined 都表示没有意见。 */
export type ToolApprovalDecision = ToolStartDecision | null | undefined;

/**
 * 决定一次工具调用的权限模式。
 *
 * 收到与 `pre_tool_call` 相同的调用信息：工具名、模型给出的入参和历史。
 * 返回 `allow`、`ask`、`deny`，或弃权（null / undefined）。函数可以是异步的。
 * 它和 `pre_tool_call` 的决策一起折叠，deny 最优先。
 */
export type ToolApprovalPattern = (
  request: ToolCallHookEvent
) => ToolApprovalDecision | Promise<ToolApprovalDecision>;

/**
 * 求一次调用的审批决策。
 *
 * 没有注册函数时返回 undefined。函数抛错只告警并视为弃权：一个坏规则不能
 * 中断回合，也不能静默放行。
 */
export async function evaluateToolApproval(
  pattern: ToolApprovalPattern | undefined,
  request: ToolCallHookEvent
): Promise<ToolStartDecision | undefined> {
  if (!pattern) {
    return undefined;
  }

  try {
    return (await pattern(request)) ?? undefined;
  } catch (error) {
    logger.warn("[tool-approval] pattern failed", error);
    return undefined;
  }
}
