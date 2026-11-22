import type { McpToolAnnotations } from "@ai-sdk/mcp";

/** The Approval Class of one Tool call. The policy reads the class, not the Tool name. */
export type ApprovalClass = "read" | "mutate" | "exec" | "interact" | "unknown";

/**
 * The class table for built-in Tools.
 *
 * A Tool that writes to disk or runs a command needs a row here. A missing row makes
 * it unknown, and Read-Only does not stop it. Tools left out on purpose (`task`,
 * `web-fetch`, timers, jobs) are also unknown, so Standard asks the same set.
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

/** Read the built-in table. An unknown Tool becomes unknown, which is safer than read. */
export function classifyTool(toolName: string): ApprovalClass {
  return BUILTIN[toolName] ?? "unknown";
}

/**
 * MCP annotations to classes.
 *
 * An annotation is a third-party claim, so treat it as untrusted: only a clear
 * read-only claim is read, only a destructive claim is mutate, the rest is unknown. It reads like `createMcpToolApprovalPattern`.
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
