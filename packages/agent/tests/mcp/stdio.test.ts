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
});
