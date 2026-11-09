import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { McpServerConfig } from "../../src/mcp/config.js";
import { McpConnection } from "../../src/mcp/connection.js";

const fixture = fileURLToPath(
  new URL("fixtures/echo-server.mjs", import.meta.url)
);

const server: McpServerConfig = {
  id: "echo",
  name: "echo",
  enabled: true,
  autoApprove: false,
  transport: {
    type: "stdio",
    command: process.execPath,
    args: [fixture],
    env: {},
  },
};

function isAlive(pid: number): boolean {
  try {
    // 信号 0 不发信号，只问内核这个 pid 还在不在。
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等子进程真的退出；进程退出是异步的，close() 返回时它可能还没走完。 */
async function waitForExit(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  return false;
}

describe("stdio transport", () => {
  test("spawns a real server, lists its tools and calls one", async () => {
    const connection = new McpConnection(server, { connectTimeoutMs: 10_000 });

    try {
      const tools = await connection.listTools();
      expect(tools.map((tool) => tool.name)).toStrictEqual(["echo"]);
      expect(tools[0]?.annotations).toStrictEqual({ readOnlyHint: true });

      const result = await connection.callTool("echo", { message: "hi" });
      expect(result.content).toStrictEqual([
        { type: "text", text: "echo: hi" },
      ]);
    } finally {
      await connection.close();
    }
  }, 20_000);

  test("kills the child process when the connection closes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcp-echo-"));
    const pidFile = path.join(dir, "pid");
    const serverWithPid: McpServerConfig = {
      ...server,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { ECHO_PID_FILE: pidFile },
      },
    };
    const connection = new McpConnection(serverWithPid, {
      connectTimeoutMs: 10_000,
    });

    try {
      await connection.listTools();
      const pid = Number(await readFile(pidFile, "utf-8"));
      expect(Number.isInteger(pid)).toBeTruthy();

      await connection.close();

      // 幂等：第二次 close 不该抛错，也不该让断言失真。
      await connection.close();

      await expect(waitForExit(pid)).resolves.toBeTruthy();
    } finally {
      await connection.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
