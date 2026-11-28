/**
 * A provider key may be just the name of an environment variable.
 *
 * This layer goes through the real app, the real database and the transport the screen
 * uses, so the assertions are on what a caller actually reads: what is stored, where a
 * bad name is rejected, and which sentence a missing key produces.
 *
 * `@workspace/db` opens its connection from `DATABASE_URL` when it is imported, so the
 * database must be chosen before that import: the variable is set first, and the module
 * is imported dynamically inside `beforeAll`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { startFakeProvider } from "@workspace/agent/testing";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import type { AppRouterClient } from "../src/routers/index";
import { userTurn } from "./helpers/compaction-fixtures";

const dir = mkdtempSync(path.join(tmpdir(), "aify-settings-key-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
// Session and project directories derive from the home directory; point it at a
// temporary one so the case writes nothing into the real home.
process.env.HOME = dir;

const API_TOKEN = "test-api-token";
const ENV = "AIFY_PROVIDER_KEY_ROUTER";

interface TestApp {
  request: (
    input: string | Request,
    init?: RequestInit
  ) => Response | Promise<Response>;
}

let app: TestApp;
let client: AppRouterClient;

/**
 * A provider that names an environment variable.
 *
 * The variable's value is put in place by the test, which is the situation a person who
 * starts the API with the key already exported is in.
 */
function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "env-provider",
    name: "Env",
    protocol: "openai-chat" as const,
    baseURL: "http://127.0.0.1:9/v1",
    apiKey: "",
    active: true,
    models: [{ id: "env-model", name: "Env model", active: true }],
    ...overrides,
  };
}

/** Wait for a condition, for at most five seconds. */
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  throw new Error("condition did not become true in time");
}

describe("供应商密钥来自环境变量", () => {
  beforeAll(async () => {
    // This file needs an unreadable variable, so it is pinned to an empty string: a
    // developer who happens to export the same name must not change the result.
    vi.stubEnv(ENV, "");

    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const { createApp } = await import("../src/app");
    app = createApp({ apiToken: () => API_TOKEN });

    client = createORPCClient(
      new RPCLink({
        url: "http://aify.test/api/rpc",
        headers: { authorization: `Bearer ${API_TOKEN}` },
        fetch: async (request) => await app.request(request),
      })
    );
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test("存下来的是变量名，读回来也没有值", async () => {
    const saved = await client.setting.update({
      providers: [providerRow({ apiKeyEnv: ENV })],
    });

    expect(saved.providers[0]?.apiKeyEnv).toBe(ENV);
    expect(saved.providers[0]?.apiKey).toBe("");

    const read = await client.setting.get();
    expect(read.providers[0]?.apiKey).toBe("");
    expect(read.providers[0]?.apiKeyEnv).toBe(ENV);
  });

  test("命名空间外的变量名在保存那一刻被拒", async () => {
    const rejection = await client.setting
      .update({ providers: [providerRow({ apiKeyEnv: "PATH" })] })
      .catch((error: unknown) => error);

    expect(rejection).toMatchObject({ code: "BAD_REQUEST" });
    // The sentence that names the namespace travels in the validation issues. The
    // screen shows the message alone, so this is where a caller finds the rule.
    expect(JSON.stringify(rejection)).toContain("AIFY_PROVIDER_KEY_");
  });

  test("两个来源同时给被拒", async () => {
    await expect(
      client.setting.update({
        providers: [providerRow({ apiKey: "sk-stored", apiKeyEnv: ENV })],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("环境里的密钥真的随请求发到供应商", async () => {
    const fake = await startFakeProvider({ scenario: "outbox" });
    vi.stubEnv(ENV, "env-key");

    try {
      await client.setting.update({
        providers: [providerRow({ apiKeyEnv: ENV, baseURL: fake.baseURL })],
      });

      await client.session.createSession({
        sessionId: "s-call",
        turns: [userTurn("turn-call", "hi")],
        model: { providerId: "env-provider", modelId: "env-model" },
      });

      // Wait for the call itself: this is the only place that shows what reached the
      // wire. A wait that timed out says the run never called the provider.
      await waitFor(() => fake.requests.length > 0);

      expect(fake.requests.length).toBeGreaterThan(0);
      for (const request of fake.requests) {
        expect(request.authorization).toBe("Bearer env-key");
      }
    } finally {
      await fake.close();
      vi.stubEnv(ENV, "");
    }
  });

  test("变量为空时，开一轮就点名这个变量", async () => {
    await client.setting.update({
      providers: [providerRow({ apiKeyEnv: ENV })],
    });

    await expect(
      client.session.createSession({
        sessionId: "s-key",
        turns: [userTurn("turn-key", "hi")],
        model: { providerId: "env-provider", modelId: "env-model" },
      })
    ).rejects.toMatchObject({
      code: "PROVIDER_KEY_MISSING",
      data: { providerId: "env-provider", env: ENV },
      message: expect.stringContaining(ENV),
    });
  });
});
