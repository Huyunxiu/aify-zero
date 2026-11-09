import type { ToolApprovalPattern } from "../tool-approval";
import { splitMcpToolName } from "./config";
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
 *
 * 查不到注解不等于安全：前缀是我们的服务器、工具表里却没有它（旧回合手里
 * 的工具、被取代的一代），一样要问。
 */
export function createMcpToolApprovalPattern(
  manager: McpManager
): ToolApprovalPattern {
  return (request) => {
    const parsed = splitMcpToolName(request.toolName);
    if (!parsed || !manager.hasServer(parsed.serverName)) {
      // 不是我们的工具名形状，交给后面的规则。
      return;
    }

    const resolved = manager.resolveTool(request.toolName);
    if (!resolved) {
      return { decision: "ask" };
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
