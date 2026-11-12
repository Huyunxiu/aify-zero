import { describe, expect, test } from "vitest";

import {
  findMcpServerProblems,
  isValidMcpServerName,
  mcpAuthType,
  mcpExposureType,
  mcpServerSchema,
  mcpToolName,
  needsMcpAuthorization,
  splitMcpToolName,
} from "../../src/mcp/config.js";

const oauthServer = {
  id: "linear",
  name: "linear",
  enabled: true,
  autoApprove: false,
  auth: { type: "oauth" as const },
  transport: {
    type: "http" as const,
    url: "https://mcp.example.com/mcp",
    headers: {},
  },
};

describe(mcpToolName, () => {
  test("prefixes the tool name with the server name", () => {
    expect(mcpToolName("linear", "create_issue")).toBe("linear__create_issue");
  });
});

describe(isValidMcpServerName, () => {
  test("accepts names that can be a tool prefix", () => {
    for (const name of ["linear", "linear-2", "a_b", "a", "0"]) {
      expect(isValidMcpServerName(name)).toBeTruthy();
    }
  });

  test("rejects names that would blur the separator", () => {
    // `ab__cd__t` 会被切分成服务器 `ab`，审批因此查不到注解。
    expect(isValidMcpServerName("ab__cd")).toBeFalsy();
    // 结尾下划线与分隔符连成 `___`，同样切错。
    expect(isValidMcpServerName("ab_")).toBeFalsy();
  });

  test("rejects names outside the character set", () => {
    for (const name of ["", "Linear", "-ab", "ab c", "ab.c", "a".repeat(33)]) {
      expect(isValidMcpServerName(name)).toBeFalsy();
    }
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
      [{ kind: "duplicate-name", name: "alpha" }]
    );
  });

  test("reports duplicate ids, because they share one connection slot", () => {
    expect(
      findMcpServerProblems([stdio, { ...stdio, name: "beta" }])
    ).toStrictEqual([{ kind: "duplicate-id", id: "a" }]);
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

describe(mcpExposureType, () => {
  test("keeps the tools out of the declared set when the field is absent", () => {
    // 旧设置里没有这个字段，读出来必须是 deferred，否则升级后行为不变。
    expect(mcpExposureType({ ...oauthServer, exposure: undefined })).toBe(
      "deferred"
    );
  });

  test("reads the explicit value", () => {
    expect(mcpExposureType({ ...oauthServer, exposure: "direct" })).toBe(
      "direct"
    );
  });

  test("parses a stored server that predates the field", () => {
    const parsed = mcpServerSchema.parse({
      id: "linear",
      name: "linear",
      transport: { type: "stdio", command: "node" },
    });

    expect(parsed.exposure).toBeUndefined();
    expect(mcpExposureType(parsed)).toBe("deferred");
  });
});

describe(mcpAuthType, () => {
  test("reads the explicit value", () => {
    expect(mcpAuthType(oauthServer)).toBe("oauth");
    expect(mcpAuthType({ ...oauthServer, auth: { type: "none" } })).toBe(
      "none"
    );
  });

  test("infers static headers from an old config without auth", () => {
    const parsed = mcpServerSchema.parse({
      id: "old",
      name: "old",
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer x" },
      },
    });

    expect(mcpAuthType(parsed)).toBe("headers");
  });

  test("falls back to none when nothing is configured", () => {
    const parsed = mcpServerSchema.parse({
      id: "plain",
      name: "plain",
      transport: { type: "http", url: "https://example.com/mcp" },
    });

    expect(mcpAuthType(parsed)).toBe("none");
  });

  test("rejects oauth on stdio, where credentials come from the environment", () => {
    expect(
      mcpServerSchema.safeParse({
        id: "local",
        name: "local",
        auth: { type: "oauth" },
        transport: { type: "stdio", command: "node" },
      }).success
    ).toBeFalsy();
  });
});

describe(needsMcpAuthorization, () => {
  test("is true only for an enabled oauth server", () => {
    expect(needsMcpAuthorization(oauthServer)).toBeTruthy();
    expect(
      needsMcpAuthorization({ ...oauthServer, enabled: false })
    ).toBeFalsy();
    expect(
      needsMcpAuthorization({ ...oauthServer, auth: { type: "headers" } })
    ).toBeFalsy();
  });
});
