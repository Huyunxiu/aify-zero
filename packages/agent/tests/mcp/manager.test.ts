import type { CallToolResult } from "@ai-sdk/mcp";
import { afterEach, describe, expect, test, vi } from "vitest";

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

const tools: McpToolDefinition[] = [
  {
    name: "create_issue",
    description: "Create an issue.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false },
  },
  {
    name: "list_issues",
    description: "List issues.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

type Spies = ReturnType<typeof createSpies>;

/** 内存连接：每个测试自己拿得到 spy，方便断言，也不会引用未绑定的方法。 */
function createSpies() {
  const listTools = vi.fn<() => Promise<readonly McpToolDefinition[]>>(() =>
    Promise.resolve(tools)
  );
  const callTool = vi.fn<McpConnectionHandle["callTool"]>(() =>
    Promise.resolve({
      content: [{ type: "text", text: "ok" }],
    } as CallToolResult)
  );
  const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const connection: McpConnectionHandle = { listTools, callTool, close };

  return { connection, listTools, callTool, close };
}

function createManager(
  spies: Spies,
  options: { idleTimeoutMs?: number; failureRetryMs?: number } = {}
) {
  const factory = vi.fn<(server: McpServerConfig) => McpConnectionHandle>(
    () => spies.connection
  );
  const manager = new McpManager({
    createConnection: factory,
    idleTimeoutMs: options.idleTimeoutMs ?? 1000,
    failureRetryMs: options.failureRetryMs ?? 60_000,
  });
  return { manager, factory };
}

describe(McpManager, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("reuses one connection across acquires", async () => {
    const spies = createSpies();
    const { manager, factory } = createManager(spies);

    await manager.acquire(server);
    await manager.acquire(server);
    manager.release(server.id);
    manager.release(server.id);

    expect(factory).toHaveBeenCalledOnce();
    expect(spies.listTools).toHaveBeenCalledOnce();
  });

  test("shares one handshake between concurrent acquires", async () => {
    const spies = createSpies();
    const { manager, factory } = createManager(spies);

    await Promise.all([manager.acquire(server), manager.acquire(server)]);

    expect(factory).toHaveBeenCalledOnce();
    expect(spies.listTools).toHaveBeenCalledOnce();
    manager.release(server.id);
    manager.release(server.id);
  });

  test("keeps the connection while the idle window has not elapsed", async () => {
    vi.useFakeTimers();
    const spies = createSpies();
    const { manager } = createManager(spies, { idleTimeoutMs: 1000 });

    await manager.acquire(server);
    manager.release(server.id);
    await vi.advanceTimersByTimeAsync(500);

    expect(spies.close).not.toHaveBeenCalled();
  });

  test("closes the connection after the idle window", async () => {
    vi.useFakeTimers();
    const spies = createSpies();
    const { manager } = createManager(spies, { idleTimeoutMs: 1000 });

    await manager.acquire(server);
    manager.release(server.id);
    await vi.advanceTimersByTimeAsync(1500);

    expect(spies.close).toHaveBeenCalledOnce();
  });

  test("does not close while a session still holds the server", async () => {
    const spies = createSpies();
    const { manager } = createManager(spies);

    await manager.acquire(server);
    await manager.acquire(server);
    manager.release(server.id);

    expect(spies.close).not.toHaveBeenCalled();
  });

  test("reports a failed server instead of throwing", async () => {
    const spies = createSpies();
    spies.listTools.mockRejectedValue(new Error("command not found"));
    const { manager } = createManager(spies);

    const snapshot = await manager.acquire(server);

    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toContain("command not found");
  });

  test("caches a failure for the retry window", async () => {
    const spies = createSpies();
    spies.listTools.mockRejectedValue(new Error("boom"));
    const { manager } = createManager(spies);

    await manager.acquire(server);
    await manager.acquire(server);

    expect(spies.listTools).toHaveBeenCalledOnce();
  });

  test("reconnects when the config changes", async () => {
    const spies = createSpies();
    const { manager, factory } = createManager(spies);

    await manager.acquire(server);
    await manager.acquire({ ...server, autoApprove: true });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(spies.close).toHaveBeenCalledOnce();
  });

  test("reconnects after invalidate, but not before the next acquire", async () => {
    const spies = createSpies();
    const { manager, factory } = createManager(spies);

    await manager.acquire(server);
    manager.invalidate();

    expect(spies.close).not.toHaveBeenCalled();

    await manager.acquire(server);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test("resolves a prefixed tool name back to its server and annotations", async () => {
    const spies = createSpies();
    const { manager } = createManager(spies);
    await manager.acquire(server);

    expect(manager.resolveTool("linear__list_issues")).toMatchObject({
      server: { name: "linear" },
      definition: { name: "list_issues", annotations: { readOnlyHint: true } },
    });
    expect(manager.resolveTool("read-file")).toBeUndefined();
  });

  test("calls a tool through the live connection", async () => {
    const spies = createSpies();
    const { manager } = createManager(spies);
    await manager.acquire(server);

    const result = await manager.callTool(server, "list_issues", {});

    expect(spies.callTool).toHaveBeenCalledWith("list_issues", {}, {});
    expect(result).toMatchObject({ content: [{ type: "text" }] });
  });

  test("refuses to call a tool while the server is not connected", async () => {
    const spies = createSpies();
    const { manager } = createManager(spies);

    await expect(manager.callTool(server, "list_issues", {})).rejects.toThrow(
      "not connected"
    );
  });

  test("tests a server on a throwaway connection", async () => {
    const spies = createSpies();
    const { manager, factory } = createManager(spies);

    const result = await manager.test(server);

    expect(result).toStrictEqual({ ok: true, toolCount: 2 });
    expect(factory).toHaveBeenCalledOnce();
    expect(spies.close).toHaveBeenCalledOnce();
    // 试连不占用正式连接：管理器里仍然没有这个服务器。
    expect(manager.statuses([server])[0]?.status).toBe("idle");
  });

  test("reports configuration state per server", async () => {
    const spies = createSpies();
    const { manager } = createManager(spies);
    await manager.acquire(server);

    expect(manager.statuses([server])).toStrictEqual([
      {
        id: "linear",
        name: "linear",
        status: "ready",
        toolCount: 2,
        error: undefined,
      },
    ]);
  });

  test("closes every connection on shutdown", async () => {
    const spies = createSpies();
    const { manager } = createManager(spies);
    await manager.acquire(server);

    await manager.close();

    expect(spies.close).toHaveBeenCalledOnce();
    expect(manager.statuses([server])[0]?.status).toBe("idle");
  });
});
