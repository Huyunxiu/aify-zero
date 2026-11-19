/**
 * 审批策略：走真实的 app、真实的数据库和真实的存储。
 *
 * 断言落在外面看得见的行为上：路由的响应、会话行里存下来的值。装配层的判定
 * 由 `packages/agent/tests` 的纯函数与组合根用例负责，这里只证明值真的落库。
 *
 * `@workspace/db` 在导入时就按 `DATABASE_URL` 建连接，所以选库必须发生在它被
 * 加载之前：先设环境变量，再在 `beforeAll` 里动态导入。
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
// 会话目录从宿主目录派生；指到临时目录，用例不往真实的家目录写。
process.env.HOME = dir;

const API_TOKEN = "test-api-token";

let client: AppRouterClient;
let store: SQLiteStore;

/** 直接写行：这是现场的搭建，不是被断言的行为。 */
async function seedSession(id: string, title: string): Promise<void> {
  await store.saveSession({ id, title, metadata: {} });
}

/** 读行上的审批档位；断言只看这一列。 */
async function storedPolicy(sessionId: string): Promise<string | undefined> {
  const { session } = await client.session.getSession({ sessionId });
  return session?.approvalPolicy;
}

describe("审批策略", () => {
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
    await seedSession("policy-1", "甲");

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
    await seedSession("policy-2", "乙");

    await expect(storedPolicy("policy-2")).resolves.toBe("standard");
  });

  test("refuses a deleted session", async () => {
    await seedSession("policy-3", "丙");
    await client.session.deleteSession({ sessionId: "policy-3" });

    await expect(
      client.session.setApprovalPolicy({
        sessionId: "policy-3",
        approvalPolicy: "edit",
      })
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
});
