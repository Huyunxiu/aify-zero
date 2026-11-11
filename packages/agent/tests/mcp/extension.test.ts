import type { CallToolResult } from "@ai-sdk/mcp";
import type { Tool } from "ai";
import { describe, expect, test, vi } from "vitest";

import { McpExtension } from "../../src/extensions/mcp.js";
import type { ExtensionAPI } from "../../src/extensions/types.js";
import type { McpServerConfig } from "../../src/mcp/config.js";
import type { McpToolDefinition } from "../../src/mcp/connection.js";
import { McpManager } from "../../src/mcp/manager.js";
import type { McpConnectionHandle } from "../../src/mcp/manager.js";
import type { ToolExposure } from "../../src/types.js";

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
  const exposure = new Map<string, ToolExposure>();
  const capabilities = new Map<string, unknown>();
  const api = {
    agent: {
      name: "main",
      sessionId: "s1",
      projectDirs: ["/tmp"],
      sessionDir: "/tmp/s1",
    },
    tool: (name: string, tool: Tool, options?: { exposure?: ToolExposure }) => {
      if (tools.has(name)) {
        throw new Error(`tool "${name}" is already registered`);
      }
      tools.set(name, tool);
      exposure.set(name, options?.exposure ?? "direct");
    },
    provide: (token: { id: string }, value: unknown) => {
      capabilities.set(token.id, value);
    },
    optional: (token: { id: string }) => capabilities.get(token.id),
  } as unknown as ExtensionAPI;

  return { api, tools, exposure, capabilities };
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

  test("keeps the server's tools out of the declared set by default", async () => {
    const { manager } = createManager();
    const { api, exposure } = createApi();
    const extension = new McpExtension({
      id: "mcp",
      manager,
      servers: [server],
    });

    await extension.init(api);

    expect([...exposure.values()]).toStrictEqual(["deferred", "deferred"]);
  });

  test("declares the tools of a server that asks to stay resident", async () => {
    const { manager } = createManager();
    const { api, exposure } = createApi();
    const extension = new McpExtension({
      id: "mcp",
      manager,
      servers: [{ ...server, exposure: "direct" }],
    });

    await extension.init(api);

    expect([...exposure.values()]).toStrictEqual(["direct", "direct"]);
  });

  test("reports a server the catalog could not search", async () => {
    const { manager } = createManager(() => Promise.reject(new Error("nope")));
    const { api, capabilities } = createApi();
    const extension = new McpExtension({
      id: "mcp",
      manager,
      servers: [server],
    });

    await extension.init(api);

    const unavailable = capabilities.get("catalogUnavailable");
    expect(unavailable).toBeTypeOf("function");
    expect((unavailable as () => unknown)()).toStrictEqual([
      { server: "linear", reason: "failed to start" },
    ]);
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
