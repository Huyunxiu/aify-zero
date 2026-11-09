import type { CallToolResult } from "@ai-sdk/mcp";
import { describe, expect, test } from "vitest";

import type { ToolCallHookEvent } from "../../src/hooks-manager.js";
import { createMcpToolApprovalPattern } from "../../src/mcp/approval.js";
import type { McpServerConfig } from "../../src/mcp/config.js";
import type { McpToolDefinition } from "../../src/mcp/connection.js";
import { McpManager } from "../../src/mcp/manager.js";
import type { McpConnectionHandle } from "../../src/mcp/manager.js";

const server: McpServerConfig = {
  id: "linear",
  name: "linear",
  enabled: true,
  autoApprove: false,
  transport: { type: "http", url: "https://example.com/mcp", headers: {} },
};

const definitions: McpToolDefinition[] = [
  {
    name: "list_issues",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "delete_issue",
    inputSchema: { type: "object" },
    annotations: { destructiveHint: true },
  },
  {
    name: "update_issue",
    inputSchema: { type: "object" },
  },
];

function request(toolName: string): ToolCallHookEvent {
  return { toolName } as ToolCallHookEvent;
}

async function pattern(
  overrides: Partial<McpServerConfig> = {}
): Promise<ReturnType<typeof createMcpToolApprovalPattern>> {
  const connection: McpConnectionHandle = {
    listTools: () => Promise.resolve(definitions),
    callTool: () => Promise.resolve({ content: [] } as CallToolResult),
    close: () => Promise.resolve(),
  };
  const manager = new McpManager({ createConnection: () => connection });
  await manager.acquire({ ...server, ...overrides });
  return createMcpToolApprovalPattern(manager);
}

describe(createMcpToolApprovalPattern, () => {
  test("abstains for tools it does not own", async () => {
    const decide = await pattern();
    expect(decide(request("read-file"))).toBeUndefined();
  });

  test("allows a read-only tool without asking", async () => {
    const decide = await pattern();
    expect(decide(request("linear__list_issues"))).toStrictEqual({
      decision: "allow",
    });
  });

  test("asks for a tool without annotations", async () => {
    const decide = await pattern();
    expect(decide(request("linear__update_issue"))).toStrictEqual({
      decision: "ask",
    });
  });

  test("never auto-approves a destructive tool", async () => {
    const decide = await pattern({ autoApprove: true });
    expect(decide(request("linear__delete_issue"))).toStrictEqual({
      decision: "ask",
    });
  });

  test("auto-approves unannotated tools when the server opts in", async () => {
    const decide = await pattern({ autoApprove: true });
    expect(decide(request("linear__update_issue"))).toStrictEqual({
      decision: "allow",
    });
  });
});
