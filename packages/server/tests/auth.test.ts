import { describe, expect, test } from "vitest";

import { authHeaders, TEST_API_TOKEN, testApp } from "./helpers";

const health = (headers?: Record<string, string>) =>
  testApp.request("/health", { headers });

describe("bearer auth", () => {
  test("rejects a request without a token", async () => {
    const response = await health();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    await expect(response.json()).resolves.toStrictEqual({
      error: "unauthorized",
    });
  });

  test("rejects a wrong token", async () => {
    const response = await health({
      authorization: `Bearer ${TEST_API_TOKEN}-wrong`,
    });

    expect(response.status).toBe(401);
  });

  test("accepts the configured token", async () => {
    const response = await health(authHeaders);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  test("protects RPC routes too", async () => {
    const response = await testApp.request("/api/rpc/lang", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(401);
  });
});
