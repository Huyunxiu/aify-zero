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
 * Read-Only and Full Access both read it. Read-Only refuses a destructive Tool. Full
 * Access closes the ask that the server declares, because the policy's allow answers
 * for the whole class — a refusal is the only answer that survives it. An annotation
 * is untrusted either way.
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
 * The approval rule for MCP Tools.
 *
 * The host mounts it as a `toolApprovalPattern`, not as a `pre_tool_call` hook. A sub
 * session inherits the approval function but not the hooks an extension registered, so
 * a hook would let an MCP call in a sub session skip the question.
 *
 * It and the policy table both answer "do we ask", but they stay apart: the table
 * covers built-in Tools, and this covers third-party Tools, because only this manager
 * reads the annotation. A merge adds a process singleton and ends table-driving.
 *
 * An annotation is the server's own claim, so treat it as untrusted: only an explicit
 * "read only" passes the call, an explicit "destructive" asks, and the rest follows the
 * server's `autoApprove`. A policy that allows the class closes that ask; a refusal is
 * the only answer that survives it.
 *
 * No annotation is not the same as safe: the prefix names a server we configured, but
 * the Tool table has no entry for it (a Tool from an older Turn, a replaced generation),
 * so the call asks.
 */
export function createMcpToolApprovalPattern(
  manager: McpManager
): ToolApprovalPattern {
  return (request) => {
    const lookup = lookupMcpTool(manager, request.toolName);
    if (!lookup.owned) {
      // Not our Tool name shape: let the later rules answer.
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
