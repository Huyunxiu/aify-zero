import { describe, expect, test } from "vitest";

import type { McpServerConfig } from "../../src/mcp/config.js";
import { McpAuthorizationFlows } from "../../src/mcp/oauth/flows.js";

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

describe(McpAuthorizationFlows, () => {
  test("takes a flow once", () => {
    const flows = new McpAuthorizationFlows();

    flows.register("state-1", server);

    expect(flows.take("state-1")).toBe(server);
    expect(flows.take("state-1")).toBeUndefined();
  });

  test("treats an expired flow as unknown", () => {
    const flows = new McpAuthorizationFlows({ ttlMs: -1 });

    flows.register("state-1", server);

    expect(flows.take("state-1")).toBeUndefined();
  });

  test("forgets every flow of one server", () => {
    const flows = new McpAuthorizationFlows();

    flows.register("state-1", server);
    flows.register("state-2", server);
    flows.forget(server.id);

    expect(flows.size).toBe(0);
  });
});
