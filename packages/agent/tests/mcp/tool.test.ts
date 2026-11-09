import type { CallToolResult } from "@ai-sdk/mcp";
import { describe, expect, test } from "vitest";

import type { McpServerConfig } from "../../src/mcp/config.js";
import type { McpToolDefinition } from "../../src/mcp/connection.js";
import { createMcpTool } from "../../src/mcp/tool.js";
import type { ToolOutput } from "../../src/tools/types.js";

const server: McpServerConfig = {
  id: "fs",
  name: "fs",
  enabled: true,
  autoApprove: false,
  transport: {
    type: "stdio",
    command: "node",
    args: [],
    env: {},
  },
};

const definition: McpToolDefinition = {
  name: "read",
  description: "Read a file.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
  },
};

const execute = async (
  result: CallToolResult | Error,
  options: { definition?: McpToolDefinition } = {}
): Promise<ToolOutput> => {
  const hostTool = createMcpTool({
    server,
    definition: options.definition ?? definition,
    call: () => {
      if (result instanceof Error) {
        return Promise.reject(result);
      }
      return Promise.resolve(result);
    },
  });

  return (await hostTool.execute?.({ path: "/tmp/a" }, {
    toolCallId: "call-1",
    messages: [],
  } as never)) as ToolOutput;
};

describe(createMcpTool, () => {
  test("keeps the server's description and input schema", () => {
    const hostTool = createMcpTool({
      server,
      definition,
      call: () => Promise.resolve({ content: [] } as CallToolResult),
    });

    expect(hostTool.description).toBe("Read a file.");
    expect(hostTool.inputSchema).toBeDefined();
  });

  test("returns text content verbatim", async () => {
    const output = await execute({
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    } as CallToolResult);

    expect(output.code).toBe("ok");
    expect(output.output).toBe("line one\nline two");
  });

  test("keeps structured content next to text", async () => {
    const output = await execute({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { total: 2 },
    } as CallToolResult);

    expect(output.output).toContain("Structured content:");
    expect(output.output).toContain('"total": 2');
  });

  test("degrades binary content to a one line note", async () => {
    const output = await execute({
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    } as CallToolResult);

    expect(output.output).toBe("[image/png, 5 bytes]");
    expect(output.metadata?.parts).toStrictEqual([
      { type: "image", mimeType: "image/png", bytes: 5 },
    ]);
  });

  test("maps isError to an error output", async () => {
    const output = await execute({
      isError: true,
      content: [{ type: "text", text: "no such file" }],
    } as CallToolResult);

    expect(output.code).toBe("error");
    expect(output.output).toBe("no such file");
  });

  test("truncates a very large result and says so", async () => {
    const output = await execute({
      content: [{ type: "text", text: "x".repeat(300 * 1024) }],
    } as CallToolResult);

    expect(output.metadata?.truncated).toBeTruthy();
    expect(output.output).toContain("[Output truncated at 256 KB");
  });

  test("turns a thrown call into a tool error instead of failing the turn", async () => {
    const output = await execute(new Error("server went away"));

    expect(output.code).toBe("error");
    expect(output.output).toContain("server went away");
  });

  test("reports an empty result rather than an empty string", async () => {
    const output = await execute({ content: [] } as CallToolResult);

    expect(output.output).toBe("(empty result)");
  });
});
