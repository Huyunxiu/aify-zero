import type { McpAuthProvider, McpServerConfig } from "@workspace/agent";
import { describe, expect, test } from "vitest";

import type { McpAuthorizationCallbackDeps } from "../src/mcp/oauth-callback";
import { handleMcpAuthorizationCallback } from "../src/mcp/oauth-callback";

const server: McpServerConfig = {
  id: "linear",
  name: "linear",
  enabled: true,
  autoApprove: false,
  auth: { type: "oauth" },
  transport: {
    type: "http",
    url: "https://mcp.example.com/mcp",
    headers: {},
  },
};

// 回调只透传 provider，不调用它的方法；空对象足够。
const provider = {} as McpAuthProvider;

type Calls = {
  completed?: Parameters<McpAuthorizationCallbackDeps["complete"]>[0];
  authorized?: McpServerConfig;
};

function createDeps(
  overrides: Partial<McpAuthorizationCallbackDeps> = {},
  calls: Calls = {}
): McpAuthorizationCallbackDeps {
  return {
    flows: { take: () => server },
    createProvider: () => provider,
    complete: (options) => {
      calls.completed = options;
      return Promise.resolve();
    },
    authorize: (target) => {
      calls.authorized = target;
      return Promise.resolve({ status: "ready", toolCount: 1 });
    },
    ...overrides,
  };
}

describe(handleMcpAuthorizationCallback, () => {
  test("rejects a state that is not pending", async () => {
    const result = await handleMcpAuthorizationCallback(
      { state: "unknown", code: "code" },
      createDeps({ flows: { take: () => {} } })
    );

    expect(result).toStrictEqual({
      ok: false,
      message:
        "This authorization request expired. Start it again from the app.",
    });
  });

  test("fails when the user denied the authorization", async () => {
    const result = await handleMcpAuthorizationCallback(
      { state: "state" },
      createDeps()
    );

    expect(result.ok).toBeFalsy();
    expect(result.message).toContain("did not complete");
  });

  test("exchanges the code with the snapshot and reconnects that server", async () => {
    const calls: Calls = {};
    const result = await handleMcpAuthorizationCallback(
      { state: "state", code: "code", issuer: "https://auth.example.com" },
      createDeps({}, calls)
    );

    expect(result.ok).toBeTruthy();
    expect(calls.completed).toMatchObject({
      serverUrl: "https://mcp.example.com/mcp",
      code: "code",
      state: "state",
      issuer: "https://auth.example.com",
    });
    expect(calls.authorized).toBe(server);
  });

  test("reports a reconnect that still needs authorization", async () => {
    const result = await handleMcpAuthorizationCallback(
      { state: "state", code: "code" },
      createDeps({
        authorize: () =>
          Promise.resolve({ status: "needs-auth" as const, toolCount: 0 }),
      })
    );

    expect(result.ok).toBeFalsy();
  });

  test("does not use the authorization flow for a stdio snapshot", async () => {
    const stdio: McpServerConfig = {
      ...server,
      transport: { type: "stdio", command: "node", args: [], env: {} },
    };

    const result = await handleMcpAuthorizationCallback(
      { state: "state", code: "code" },
      createDeps({ flows: { take: () => stdio } })
    );

    expect(result).toStrictEqual({
      ok: false,
      message: "This MCP server does not use the authorization flow.",
    });
  });
});
