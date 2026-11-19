/**
 * Approval Policy: the real app, the real database, and the real storage.
 *
 * The assertions check visible behavior: the router response and the value in the session
 * row. The pure functions and the composition root cases in `packages/agent/tests` cover assembly; this proves the write.
 *
 * `@workspace/db` opens its connection from `DATABASE_URL` at import, so select the
 * database before the import: set the environment variable, then import dynamically in `beforeAll`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { beforeAll, describe, expect, test } from "vitest";

import type { AppRouterClient } from "../src/routers/index";
import type { SQLiteStore } from "../src/storage/sqlite-store";

const dir = mkdtempSync(path.join(tmpdir(), "aify-approval-policy-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
// The session directory derives from the home directory. Point it at a temporary directory, so the test writes nothing to the real home.
process.env.HOME = dir;

const API_TOKEN = "test-api-token";

let client: AppRouterClient;
let store: SQLiteStore;

/** Write the row directly. This is test setup, not asserted behavior. */
async function seedSession(id: string, title: string): Promise<void> {
  await store.saveSession({ id, title, metadata: {} });
}

/** Read the Approval Policy from the row. The assertion reads this column only. */
async function storedPolicy(sessionId: string): Promise<string | undefined> {
  const { session } = await client.session.getSession({ sessionId });
  return session?.approvalPolicy;
}

describe("approval policy", () => {
  beforeAll(async () => {
    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const { createApp } = await import("../src/app");
    const app = createApp({ apiToken: () => API_TOKEN });

    const storeModule = await import("../src/storage/sqlite-store");
    store = new storeModule.SQLiteStore();

    client = createORPCClient(
      new RPCLink({
        url: "http://aify.test/api/rpc",
        headers: { authorization: `Bearer ${API_TOKEN}` },
        fetch: async (request) => await app.request(request),
      })
    );
  });

  test("stores the chosen tier on the session row", async () => {
    await seedSession("policy-1", "first");

    const result = await client.session.setApprovalPolicy({
      sessionId: "policy-1",
      approvalPolicy: "readonly",
    });

    expect(result).toStrictEqual({
      sessionId: "policy-1",
      approvalPolicy: "readonly",
    });
    await expect(storedPolicy("policy-1")).resolves.toBe("readonly");
  });

  test("starts at the standard tier without anyone choosing", async () => {
    await seedSession("policy-2", "second");

    await expect(storedPolicy("policy-2")).resolves.toBe("standard");
  });

  test("refuses a deleted session", async () => {
    await seedSession("policy-3", "third");
    await client.session.deleteSession({ sessionId: "policy-3" });

    await expect(
      client.session.setApprovalPolicy({
        sessionId: "policy-3",
        approvalPolicy: "edit",
      })
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
});
