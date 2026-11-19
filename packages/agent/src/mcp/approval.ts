import type { ApprovalClass } from "../approval-classes";
import { classifyAnnotations } from "../approval-classes";
import type { ToolApprovalPattern } from "../tool-approval";
import { splitMcpToolName } from "./config";
import type { McpManager } from "./manager";

/** 一次工具名查询：是不是我们的 MCP 工具，是的话解析结果可能仍缺。 */
type McpToolLookup =
  | { owned: false }
  | { owned: true; resolved: ReturnType<McpManager["resolveTool"]> };

/**
 * 先判断「是不是我们配置过的服务器」，再解析。
 *
 * 两个调用点都要走这两步，所以判断只留在这里：前缀是我们的、服务器却不在
 * 配置里时，`resolveTool` 也会返回空，但两者的意思不同——前者不是 MCP 工具，
 * 后者是拿不到的旧工具。
 */
function lookupMcpTool(manager: McpManager, toolName: string): McpToolLookup {
  const parsed = splitMcpToolName(toolName);
  if (!parsed || !manager.hasServer(parsed.serverName)) {
    return { owned: false };
  }

  return { owned: true, resolved: manager.resolveTool(toolName) };
}

/**
 * MCP 工具的审批类别；不是我们的工具时返回 undefined，交给内置表。
 *
 * 只读策略和全放行策略都靠它：前者据此拒绝破坏性工具，后者据此保留「服务器
 * 自己承认会破坏」的那一次询问。注解是第三方自述，按不可信处理。
 */
export function mcpApprovalClass(
  manager: McpManager,
  toolName: string
): ApprovalClass | undefined {
  const lookup = lookupMcpTool(manager, toolName);
  if (!lookup.owned) {
    return undefined;
  }

  // 前缀是我们的、工具表里却没有它：不知道它做什么，就按未知处理。
  return lookup.resolved
    ? classifyAnnotations(lookup.resolved.definition.annotations)
    : "unknown";
}

/**
 * MCP 工具的审批规则。
 *
 * 返回给宿主挂到 `toolApprovalPattern` 上，而不是 `pre_tool_call`：
 * 子会话只继承审批函数，不继承扩展注册的 hook，放在 hook 里会让子会话里
 * 的 MCP 调用绕过询问。
 *
 * 它和策略表都回答「要不要问」，但为什么不合并成一处：策略表管内置工具，
 * 这里管第三方工具，注解只有这个管理器查得到。合并就要让 `approval-policy.ts`
 * 依赖一个进程级单例，那张纯函数表也就不能再表驱动。
 *
 * 注解是第三方自述，按不可信处理：只有明确说「只读」才自动放行，明确说
 * 「破坏性」就永远询问，其余看服务器自己的 `autoApprove`。
 *
 * 查不到注解不等于安全：前缀是我们的服务器、工具表里却没有它（旧回合手里
 * 的工具、被取代的一代），一样要问。
 */
export function createMcpToolApprovalPattern(
  manager: McpManager
): ToolApprovalPattern {
  return (request) => {
    const lookup = lookupMcpTool(manager, request.toolName);
    if (!lookup.owned) {
      // 不是我们的工具名形状，交给后面的规则。
      return;
    }

    if (!lookup.resolved) {
      return { decision: "ask" };
    }

    const { server, definition } = lookup.resolved;
    const toolClass = classifyAnnotations(definition.annotations);

    // 类别只判一次：注解的读法归 `approval-classes`，策略也拿同一个结果回答。
    // 两处各写一遍「破坏性优先于只读」迟早会分叉。
    if (toolClass === "mutate") {
      return { decision: "ask" };
    }

    if (toolClass === "read") {
      return { decision: "allow" };
    }

    return server.autoApprove ? { decision: "allow" } : { decision: "ask" };
  };
}
