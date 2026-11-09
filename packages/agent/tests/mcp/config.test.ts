import { describe, expect, test } from "vitest";

import {
  findMcpServerProblems,
  mcpServerSchema,
  mcpToolName,
  splitMcpToolName,
} from "../../src/mcp/config.js";

describe(mcpToolName, () => {
  test("prefixes the tool name with the server name", () => {
    expect(mcpToolName("linear", "create_issue")).toBe("linear__create_issue");
  });
});

describe(splitMcpToolName, () => {
  test("splits on the first separator only", () => {
    expect(splitMcpToolName("linear__create__issue")).toStrictEqual({
      serverName: "linear",
      toolName: "create__issue",
    });
  });

  test("returns undefined for names that are not prefixed", () => {
    expect(splitMcpToolName("read-file")).toBeUndefined();
    expect(splitMcpToolName("__tool")).toBeUndefined();
    expect(splitMcpToolName("linear__")).toBeUndefined();
  });
});

describe(findMcpServerProblems, () => {
  const stdio = {
    id: "a",
    name: "alpha",
    enabled: true,
    autoApprove: false,
    transport: { type: "stdio" as const, command: "node", args: [], env: {} },
  };

  test("reports duplicate names, because the name is the tool prefix", () => {
    expect(findMcpServerProblems([stdio, { ...stdio, id: "b" }])).toStrictEqual(
      ["duplicate server name: alpha"]
    );
  });

  test("accepts a well formed list", () => {
    expect(
      findMcpServerProblems([stdio, { ...stdio, id: "b", name: "beta" }])
    ).toStrictEqual([]);
  });
});

describe("MCP server config", () => {
  test("fills transport defaults", () => {
    const parsed = mcpServerSchema.parse({
      id: "linear",
      name: "linear",
      transport: { type: "http", url: "https://example.com/mcp" },
    });

    expect(parsed.enabled).toBeTruthy();
    expect(parsed.autoApprove).toBeFalsy();
    expect(parsed.transport).toStrictEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: {},
    });
  });

  test("rejects a name that cannot be a tool prefix", () => {
    expect(
      mcpServerSchema.safeParse({
        id: "x",
        name: "Linear Server",
        transport: { type: "stdio", command: "node" },
      }).success
    ).toBeFalsy();
  });
});
