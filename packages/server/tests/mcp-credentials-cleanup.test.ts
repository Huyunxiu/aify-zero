import type { McpServerConfig } from "@workspace/agent";
import { describe, expect, test } from "vitest";

import { keepsMcpCredentials } from "../src/mcp/credentials-cleanup";

const oauthServer: McpServerConfig = {
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

const movedServer: McpServerConfig = {
  ...oauthServer,
  transport: {
    type: "http",
    url: "https://other.example/mcp",
    headers: {},
  },
};

const sseServer: McpServerConfig = {
  ...oauthServer,
  transport: {
    type: "sse",
    url: "https://mcp.example.com/mcp",
    headers: {},
  },
};

const headersServer: McpServerConfig = {
  ...oauthServer,
  auth: { type: "headers" },
};

const stdioServer: McpServerConfig = {
  ...oauthServer,
  transport: { type: "stdio", command: "node", args: [], env: {} },
};

describe(keepsMcpCredentials, () => {
  test("keeps the tokens while the same oauth server stays in place", () => {
    expect(keepsMcpCredentials(oauthServer, { ...oauthServer })).toBeTruthy();
  });

  test("drops them when the server is gone", () => {
    expect(keepsMcpCredentials(oauthServer)).toBeFalsy();
  });

  test("drops them when the url changes", () => {
    expect(keepsMcpCredentials(oauthServer, movedServer)).toBeFalsy();
  });

  test("drops them when the transport changes", () => {
    expect(keepsMcpCredentials(oauthServer, sseServer)).toBeFalsy();
  });

  test("drops them after switching back to static headers", () => {
    expect(keepsMcpCredentials(oauthServer, headersServer)).toBeFalsy();
  });

  test("does not keep anything for a stdio server", () => {
    expect(keepsMcpCredentials(stdioServer, { ...stdioServer })).toBeFalsy();
  });
});
