import type { CallToolResult } from "@ai-sdk/mcp";
import type { Tool } from "ai";
import { describe, expect, test, vi } from "vitest";

import { McpExtension } from "../../src/extensions/mcp.js";
import type { ExtensionAPI } from "../../src/extensions/types.js";
import type { McpServerConfig } from "../../src/mcp/config.js";
import type { McpToolDefinition } from "../../src/mcp/connection.js";
import { McpManager } from "../../src/mcp/manager.js";
import type { McpConnectionHandle } from "../../src/mcp/manager.js";

const definitions: McpToolDefinition[] = [
  {
    name: "create_issue",
    description: "Create an issue.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_issues",
    inputSchema: { type: "object", properties: {} },
  },
];

const server: McpServerConfig = {
  id: "linear",
  name: "linear",
  enabled: true,
  autoApprove: false,
  transport: { type: "http", url: "https://example.com/mcp", headers: {} },
};

/** 只实现扩展真正用到的那部分 API。 */
function createApi() {
  const tools = new Map<string, Tool>();
  const api = {
    agent: {
      name: "main",
      sessionId: "s1",
      projectDirs: ["/tmp"],
      sessionDir: "/tmp/s1",
    },
    tool: (name: string, tool: Tool) => {
      if (tools.has(name)) {
        throw new Error(`tool "${name}" is already registered`);
      }
      tools.set(name, tool);
    },
  } as unknown as ExtensionAPI;

  return { api, tools };
}

function createManager(
  listTools: McpConnectionHandle["listTools"] = () =>
    Promise.resolve(definitions)
) {
  const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const connection: McpConnectionHandle = {
    listTools,
    callTool: () => Promise.resolve({ content: [] } as CallToolResult),
    close,
  };
  const manager = new McpManager({ createConnection: () => connection });
  return { manager, close };
}

describe(McpExtension, () => {
  test("registers every tool under the server prefix", async () => {
    const { manager } = createManager();
    const { api, tools } = createApi();
    const extension = new McpExtension({
      id: "mcp",
      manager,
      servers: [server],
    });

    await extension.init(api);

    expect([...tools.keys()]).toStrictEqual([
      "linear__create_issue",
      "linear__list_issues",
    ]);
  });

  test("skips a server that is turned off", async () => {
    const { manager } = createManager();
    const { api, tools } = createApi();
    const extension = new McpExtension({
      id: "mcp",
      manager,
      servers: [{ ...server, enabled: false }],
    });

    await extension.init(api);

    expect(tools.size).toBe(0);
  });

  test("keeps the session running when a server fails to start", async () => {
    const { manager } = createManager(() => Promise.reject(new Error("nope")));
    const { api, tools } = createApi();
    const extension = new McpExtension({
      id: "mcp",
      manager,
      servers: [server],
    });

    await expect(extension.init(api)).resolves.toBeUndefined();
    expect(tools.size).toBe(0);
  });

  test("releases its holds so the connection can go idle", async () => {
    const { manager, close } = createManager();
    const { api } = createApi();
    const extension = new McpExtension({
      id: "mcp",
      manager,
      servers: [server],
    });

    await extension.init(api);
    extension.dispose();

    // 引用归零后连接还活着，等空闲计时器收；这里确认没有立刻断开。
    expect(close).not.toHaveBeenCalled();
    expect(manager.statuses([server])[0]?.status).toBe("ready");
  });
});
