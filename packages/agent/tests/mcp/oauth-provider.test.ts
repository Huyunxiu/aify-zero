import type { OAuthTokens } from "@ai-sdk/mcp";
import { describe, expect, test } from "vitest";

import { McpOAuthProvider } from "../../src/mcp/oauth/provider.js";
import { createMemoryCredentialStore } from "./helpers/memory-credential-store.js";

const server = {
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

const tokens: OAuthTokens = {
  access_token: "first",
  token_type: "Bearer",
  refresh_token: "refresh",
};

function createProvider() {
  const store = createMemoryCredentialStore();
  const provider = new McpOAuthProvider({
    serverId: server.id,
    store,
    redirectUrl: "http://127.0.0.1:18086/api/mcp/oauth/callback",
  });

  return { provider, store };
}

describe(McpOAuthProvider, () => {
  test("round-trips tokens", async () => {
    const { provider } = createProvider();

    await provider.saveTokens(tokens);

    await expect(provider.tokens()).resolves.toStrictEqual(tokens);
  });

  test("keeps the state next to the code verifier", async () => {
    const { provider } = createProvider();

    await provider.saveState("state-1");
    await provider.saveCodeVerifier("verifier-1");

    await expect(provider.storedState()).resolves.toBe("state-1");
    await expect(provider.codeVerifier()).resolves.toBe("verifier-1");
  });

  test("does not delete tokens that were replaced by a concurrent refresh", async () => {
    const { provider } = createProvider();

    await provider.saveTokens(tokens);
    const newer: OAuthTokens = { ...tokens, access_token: "second" };
    await provider.saveTokens(newer);

    // 晚到的失效带的是旧的那一份：代次已经变了，删除必须落空。
    await provider.invalidateCredentials("tokens", { tokens });
    await expect(provider.tokens()).resolves.toStrictEqual(newer);

    await provider.invalidateCredentials("tokens", { tokens: newer });
    await expect(provider.tokens()).resolves.toBeUndefined();
  });

  test("drops the client only when the scope says so", async () => {
    const { provider } = createProvider();

    await provider.saveClientInformation({ client_id: "client-1" });
    await provider.invalidateCredentials("tokens");

    await expect(provider.clientInformation()).resolves.toStrictEqual({
      client_id: "client-1",
    });

    await provider.invalidateCredentials("all");

    await expect(provider.clientInformation()).resolves.toBeUndefined();
  });

  test("rejects an authorization server that is neither https nor loopback", () => {
    const { provider } = createProvider();

    expect(() =>
      provider.validateAuthorizationServerURL(
        "https://mcp.example.com/mcp",
        "http://auth.example.com"
      )
    ).toThrow(/https/);

    expect(() =>
      provider.validateAuthorizationServerURL(
        "https://mcp.example.com/mcp",
        "http://127.0.0.1:9000"
      )
    ).not.toThrow();

    expect(() =>
      provider.validateAuthorizationServerURL(
        "https://mcp.example.com/mcp",
        "https://auth.example.com"
      )
    ).not.toThrow();
  });

  test("captures the authorization URL instead of opening a browser", () => {
    const { provider } = createProvider();
    const url = new URL("https://auth.example.com/authorize?client_id=x");

    provider.redirectToAuthorization(url);

    expect(provider.authorizationUrl?.toString()).toBe(url.toString());
  });
});
