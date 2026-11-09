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

    const first = await manager.acquire(server);
    const second = await manager.acquire(server);
    first.release();
    second.release();

    expect(factory).toHaveBeenCalledOnce();
    expect(spies.listTools).toHaveBeenCalledOnce();
  });

  test("shares one handshake between concurrent acquires", async () => {
    const spies = createSpies();
    const { manager, factory } = createManager(spies);

    const leases = await Promise.all([
      manager.acquire(server),
      manager.acquire(server),
    ]);

    expect(factory).toHaveBeenCalledOnce();
    expect(spies.listTools).toHaveBeenCalledOnce();
    for (const lease of leases) {
      lease.release();
    }
  });

  test("keeps the connection while the idle window has not elapsed", async () => {
    vi.useFakeTimers();
    const spies = createSpies();
    const { manager } = createManager(spies, { idleTimeoutMs: 1000 });

    const lease = await manager.acquire(server);
    lease.release();
    await vi.advanceTimersByTimeAsync(500);

    expect(spies.close).not.toHaveBeenCalled();
  });

  test("closes the connection after the idle window", async () => {
    vi.useFakeTimers();
    const spies = createSpies();
    const { manager } = createManager(spies, { idleTimeoutMs: 1000 });

    const lease = await manager.acquire(server);
    lease.release();
    await vi.advanceTimersByTimeAsync(1500);

    expect(spies.close).toHaveBeenCalledOnce();
  });

  test("does not close while a session still holds the server", async () => {
    const spies = createSpies();
    const { manager } = createManager(spies);

    const first = await manager.acquire(server);
    const second = await manager.acquire(server);
    first.release();

    expect(spies.close).not.toHaveBeenCalled();
    second.release();
  });

  test("reports a failed server instead of throwing", async () => {
    const spies = createSpies();
    spies.listTools.mockRejectedValue(new Error("command not found"));
    const { manager } = createManager(spies);

    const lease = await manager.acquire(server);

    expect(lease.status).toBe("failed");
    expect(lease.error).toContain("command not found");
    lease.release();
  });

  test("caches a failure for the retry window", async () => {
    const spies = createSpies();
    spies.listTools.mockRejectedValue(new Error("boom"));
    const { manager } = createManager(spies);

    const first = await manager.acquire(server);
    const second = await manager.acquire(server);
    first.release();
    second.release();

    expect(spies.listTools).toHaveBeenCalledOnce();
  });

  test("returns the reference count after concurrent failures", async () => {
    vi.useFakeTimers();
    const spies = createSpies();
    spies.listTools.mockRejectedValue(new Error("boom"));
    const { manager } = createManager(spies, { idleTimeoutMs: 1000 });

    const leases = await Promise.all([
      manager.acquire(server),
      manager.acquire(server),
    ]);
    for (const lease of leases) {
      lease.release();
    }
    // 失败时连接已经收过一次；引用归零后空闲计时器还会再收一次。
    await vi.advanceTimersByTimeAsync(1500);

    expect(spies.close).toHaveBeenCalledTimes(2);
  });

  test("reconnects when the config changes", async () => {
    const spies = createSpies();
    const { manager, factory } = createManager(spies);

    const first = await manager.acquire(server);
    const second = await manager.acquire({ ...server, autoApprove: true });

    expect(factory).toHaveBeenCalledTimes(2);
    // 旧的一代还有人拿着，不能中途断开。
    expect(spies.close).not.toHaveBeenCalled();

    first.release();
    expect(spies.close).toHaveBeenCalledOnce();
    second.release();
  });

  test("reconnects after invalidate, but not before the next acquire", async () => {
    const spies = createSpies();
    const { manager, factory } = createManager(spies);

    const first = await manager.acquire(server);
    manager.invalidate();

    expect(spies.close).not.toHaveBeenCalled();

    const second = await manager.acquire(server);
    expect(factory).toHaveBeenCalledTimes(2);

    first.release();
    second.release();
  });

  test("keeps a running turn working after invalidate", async () => {
    const spies = createSpies();
    const { manager } = createManager(spies);
    const lease = await manager.acquire(server);

    manager.invalidate();

    await expect(lease.callTool("list_issues", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    // 审批靠旧工具表认注解，失效后也必须查得到。
    expect(manager.resolveTool("linear__list_issues")).toMatchObject({
      definition: { annotations: { readOnlyHint: true } },
    });
    lease.release();
  });

  test("resolves a prefixed tool name back to its server and annotations", async () => {
    const spies = createSpies();
    const { manager } = createManager(spies);
    const lease = await manager.acquire(server);

    expect(manager.resolveTool("linear__list_issues")).toMatchObject({
      server: { name: "linear" },
      definition: { name: "list_issues", annotations: { readOnlyHint: true } },
    });
    expect(manager.resolveTool("read-file")).toBeUndefined();
    lease.release();
  });

  test("knows its own server prefixes", async () => {
    const spies = createSpies();
    const { manager } = createManager(spies);
    const lease = await manager.acquire(server);

    expect(manager.hasServer("linear")).toBeTruthy();
    expect(manager.hasServer("other")).toBeFalsy();
    lease.release();
  });

  test("calls a tool through the live connection", async () => {
    const spies = createSpies();
    const { manager } = createManager(spies);
    const lease = await manager.acquire(server);

    const result = await lease.callTool("list_issues", {});

    expect(spies.callTool).toHaveBeenCalledWith("list_issues", {}, undefined);
    expect(result).toMatchObject({ content: [{ type: "text" }] });
    lease.release();
  });

  test("refuses to call a tool while the server is not connected", async () => {
    const spies = createSpies();
    spies.listTools.mockRejectedValue(new Error("nope"));
    const { manager } = createManager(spies);
    const lease = await manager.acquire(server);

    await expect(lease.callTool("list_issues", {})).rejects.toThrow(
      "not connected"
    );
    lease.release();
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
    const lease = await manager.acquire(server);

    expect(manager.statuses([server])).toStrictEqual([
      {
        id: "linear",
        name: "linear",
        status: "ready",
        toolCount: 2,
        error: undefined,
      },
    ]);
    lease.release();
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
