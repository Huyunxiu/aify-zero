import type { ToolApprovalPattern } from "../tool-approval";
import type { McpManager } from "./manager";

/**
 * MCP 工具的审批规则。
 *
 * 返回给宿主挂到 `toolApprovalPattern` 上，而不是 `pre_tool_call`：
 * 子会话只继承审批函数，不继承扩展注册的 hook，放在 hook 里会让子会话里
 * 的 MCP 调用绕过询问。
 *
 * 注解是第三方自述，按不可信处理：只有明确说「只读」才自动放行，明确说
 * 「破坏性」就永远询问，其余看服务器自己的 `autoApprove`。
 */
export function createMcpToolApprovalPattern(
  manager: McpManager
): ToolApprovalPattern {
  return (request) => {
    const resolved = manager.resolveTool(request.toolName);
    if (!resolved) {
      // 不是 MCP 工具，交给后面的规则。
      return;
    }

    const { server, definition } = resolved;
    const { annotations } = definition;

    if (annotations?.destructiveHint === true) {
      return { decision: "ask" };
    }

    if (annotations?.readOnlyHint === true) {
      return { decision: "allow" };
    }

    return server.autoApprove ? { decision: "allow" } : { decision: "ask" };
  };
}
