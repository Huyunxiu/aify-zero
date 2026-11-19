import type { ApprovalClass } from "../approval-classes";
import { classifyAnnotations } from "../approval-classes";
import type { ToolApprovalPattern } from "../tool-approval";
import { splitMcpToolName } from "./config";
import type { McpManager } from "./manager";

/** One Tool name lookup: is it our MCP Tool, and if so, the result can still be absent. */
type McpToolLookup =
  | { owned: false }
  | { owned: true; resolved: ReturnType<McpManager["resolveTool"]> };

/**
 * First decide whether the server is one that we configured, then resolve.
 *
 * Both call sites need these two steps, so the check stays here. When the prefix is
 * ours but the server is not configured, `resolveTool` also returns empty, but the
 * meaning differs: the first is not an MCP Tool, the second is a stale Tool.
 */
function lookupMcpTool(manager: McpManager, toolName: string): McpToolLookup {
  const parsed = splitMcpToolName(toolName);
  if (!parsed || !manager.hasServer(parsed.serverName)) {
    return { owned: false };
  }

  return { owned: true, resolved: manager.resolveTool(toolName) };
}

/**
 * The Approval Class of an MCP Tool; undefined for a Tool that is not ours, which the built-in table then answers.
 *
 * Read-Only and Unrestricted both use it: Read-Only refuses a destructive Tool,
 * Unrestricted keeps the ask that the server itself declares. An annotation is untrusted.
 */
export function mcpApprovalClass(
  manager: McpManager,
  toolName: string
): ApprovalClass | undefined {
  const lookup = lookupMcpTool(manager, toolName);
  if (!lookup.owned) {
    return undefined;
  }

  // The prefix is ours but the Tool table has no entry: we do not know what it does, so treat it as unknown.
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
 * It and the policy table both answer "do we ask", but they stay apart: the table
 * covers built-in Tools, and this covers third-party Tools, because only this manager
 * reads the annotation. A merge adds a process singleton and ends table-driving.
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

    // Judge the class once: `approval-classes` owns the annotation reading, and the
    // policy answers from the same result. Two copies of "destructive before read" diverge.
    if (toolClass === "mutate") {
      return { decision: "ask" };
    }

    if (toolClass === "read") {
      return { decision: "allow" };
    }

    return server.autoApprove ? { decision: "allow" } : { decision: "ask" };
  };
}
