import type { McpToolAnnotations } from "@ai-sdk/mcp";

/** 一次工具调用在审批上的类别。策略只看类别，不看工具名。 */
export type ApprovalClass = "read" | "mutate" | "exec" | "interact" | "unknown";

/**
 * 内置工具的类别表。
 *
 * 会落盘或跑命令的工具必须在这里落一格：漏掉就成了 unknown，只读策略拦不住它。
 * 故意不列的（`task`、`web-fetch`、定时器与后台任务）也按 unknown 处理：
 * 策略对它们只剩「不表态」和「全放行」，标准策略的询问集合因此不变。
 */
const BUILTIN: Readonly<Record<string, ApprovalClass>> = {
  "delete-file": "mutate",
  "edit-file": "mutate",
  "load-skill": "read",
  "read-file": "read",
  "search-tools": "read",
  "write-file": "mutate",
  bash: "exec",
  glob: "read",
  grep: "read",
  powershell: "exec",
  questionnaire: "interact",
};

/** 查内置表；不认识的工具按 unknown，比按读取安全。 */
export function classifyTool(toolName: string): ApprovalClass {
  return BUILTIN[toolName] ?? "unknown";
}

/**
 * MCP 注解 → 类别。
 *
 * 注解是第三方自述，按不可信处理：只有明确说只读才算读取，明确说破坏性
 * 就算改动，其余一律 unknown。和 `createMcpToolApprovalPattern` 同一套读法。
 */
export function classifyAnnotations(
  annotations?: McpToolAnnotations
): ApprovalClass {
  if (annotations?.destructiveHint === true) {
    return "mutate";
  }

  if (annotations?.readOnlyHint === true) {
    return "read";
  }

  return "unknown";
}
