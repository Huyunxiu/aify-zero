/**
 * 删除会话：走真实的 app、真实的数据库和真实的运行器。
 *
 * 断言只落在外部行为上：HTTP 的响应、列表里还剩谁、存储自己的读接口还看得见什么。
 * oRPC 客户端和网页用的是同一个传输，所以这里测的正是界面走的那条路。
 *
 * `@workspace/db` 在导入时就按 `DATABASE_URL` 建连接，所以选库必须发生在它被加载
 * 之前：先设环境变量，再在 `beforeAll` 里动态导入。
 */
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { beforeAll, describe, expect, test } from "vitest";

import type { AppRouterClient } from "../src/routers/index";
import type { SQLiteStore } from "../src/storage/sqlite-store";
import { userTurn } from "./helpers/compaction-fixtures";

const dir = mkdtempSync(path.join(tmpdir(), "aify-session-delete-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
// 会话目录、项目目录都从宿主目录派生；指到临时目录，用例不往真实的家目录写。
process.env.HOME = dir;

const API_TOKEN = "test-api-token";

/** 只用到 `request`，不必把 Hono 的环境泛型拖进来。 */
interface TestApp {
  request: (
    input: string | Request,
    init?: RequestInit
  ) => Response | Promise<Response>;
}

let app: TestApp;
let client: AppRouterClient;
let store: SQLiteStore;

/** 直接写行：这是现场的搭建，不是被断言的行为。 */
async function seedSession(
  id: string,
  title: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await store.saveSession({
    id,
    title,
    metadata: {},
    status: "done",
    ...extra,
  } as Parameters<SQLiteStore["saveSession"]>[0]);
}

/** 排一个定时器：这是「将来还会发生的事」里最要紧的一类。 */
async function seedTimer(sessionId: string, toolCallId: string): Promise<void> {
  await store.insertTimer({
    sessionId,
    toolCallId,
    note: "提醒",
    dueAt: Date.now() + 60_000,
    recurrence: null,
    payload: { model: { providerId: "test-provider", modelId: "test-model" } },
  });
}

/** 等一个异步条件成立，最多五秒。 */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
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

/**
 * 一个接受连接、但一直不回答的供应商。
 *
 * 回合会停在流上，于是会话在内存里有一条活着的运行——这正是删除要拒绝的状态。
 */
async function startHangingProvider(): Promise<{
  baseURL: string;
  close: () => Promise<void>;
}> {
  const server = createServer(() => {
    // 故意不写响应：请求挂在这里，直到用例结束把它关掉。
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

const provider = (baseURL: string) => ({
  providers: [
    {
      id: "test-provider",
      name: "Test",
      protocol: "openai-chat" as const,
      baseURL,
      apiKey: "test",
      active: true,
      models: [{ id: "test-model", name: "Test", active: true }],
    },
  ],
});

describe("deleting a session", () => {
  beforeAll(async () => {
    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const { createApp } = await import("../src/app");
    app = createApp({ apiToken: () => API_TOKEN });

    const storeModule = await import("../src/storage/sqlite-store");
    store = new storeModule.SQLiteStore();

    client = createORPCClient(
      new RPCLink({
        url: "http://aify.test/api/rpc",
        headers: { authorization: `Bearer ${API_TOKEN}` },
        fetch: async (request) => await app.request(request),
      })
    );

    // 一个配好但没有服务在听的供应商：发消息要先过模型查找，过了之后才轮到会话
    // 自己的判断。需要真起一个不回话的服务时，用例里再改它的地址。
    await client.setting.update(provider("http://127.0.0.1:9/v1"));
  });

  test("should hide a session from the list", async () => {
    await seedSession("s1", "甲");
    await seedSession("keep", "乙");

    const first = await client.session.deleteSession({ sessionId: "s1" });
    expect(first).toStrictEqual({ sessionId: "s1", removed: true });

    const { sessions } = await client.session.listSessions({
      direction: "desc",
    });
    const ids = sessions.map((session) => session.id);
    expect(ids).not.toContain("s1");
    expect(ids).toContain("keep");
  });

  test("should answer removed false when there is nothing to remove", async () => {
    await seedSession("s1b", "己");

    const first = await client.session.deleteSession({ sessionId: "s1b" });
    const second = await client.session.deleteSession({ sessionId: "s1b" });
    const unknown = await client.session.deleteSession({
      sessionId: "never-existed",
    });

    expect(first).toStrictEqual({ sessionId: "s1b", removed: true });
    expect(second).toStrictEqual({ sessionId: "s1b", removed: false });
    expect(unknown).toStrictEqual({
      sessionId: "never-existed",
      removed: false,
    });
  });

  test("should cancel what would still happen to the session", async () => {
    await seedSession("s2", "丙");
    await store.insertInboxItem({
      sessionId: "s2",
      kind: "user-message",
      dedupeKey: "queued",
      deliverAt: "run-boundary",
      content: userTurn("turn-queued", "还在排队的一句"),
      payload: {
        model: { providerId: "test-provider", modelId: "test-model" },
      },
    });
    await seedTimer("s2", "call-1");
    await store.recordOutboxItem({ sessionId: "s2", turnId: "turn-done" });

    const before = await store.listOutboxCandidates({
      since: 0,
      before: Date.now() + 1000,
      limit: 100,
    });
    await client.session.deleteSession({ sessionId: "s2" });

    const { items } = await client.session.listInboxItems({ sessionId: "s2" });
    const after = await store.listOutboxCandidates({
      since: 0,
      before: Date.now() + 1000,
      limit: 100,
    });

    expect(before.some((item) => item.sessionId === "s2")).toBeTruthy();
    expect(items).toStrictEqual([]);
    await expect(store.listTimers("s2")).resolves.toStrictEqual([]);
    expect(after.some((item) => item.sessionId === "s2")).toBeFalsy();
  });

  test("should take its subagent rows along", async () => {
    await seedSession("parent-a", "父");
    await seedSession("child-a", "子", {
      kind: "subagent",
      parentSessionId: "parent-a",
      parentToolCallId: "call-task",
    });
    await seedTimer("parent-a", "call-2");
    await seedTimer("child-a", "call-3");

    await client.session.deleteSession({ sessionId: "parent-a" });

    const child = await store.findSessionRow("child-a");
    expect(child?.deletedAt).not.toBeNull();
    await expect(store.listTimers("parent-a")).resolves.toStrictEqual([]);
    await expect(store.listTimers("child-a")).resolves.toStrictEqual([]);
  });

  test("should leave forked sessions alone", async () => {
    await seedSession("parent-b", "父二");
    await seedSession("fork-b", "分支", {
      forkedFromSessionId: "parent-b",
      forkedFromMessageId: "turn-1",
    });
    await seedTimer("fork-b", "call-4");

    await client.session.deleteSession({ sessionId: "parent-b" });

    const { sessions } = await client.session.listSessions({
      direction: "desc",
    });
    const ids = sessions.map((session) => session.id);
    expect(ids).toContain("fork-b");
    await expect(store.listTimers("fork-b")).resolves.toHaveLength(1);
  });

  test("should behave like it does not exist for reads and new messages", async () => {
    await seedSession("gone", "丁");
    await client.session.deleteSession({ sessionId: "gone" });

    const { session } = await client.session.getSession({ sessionId: "gone" });
    const turns = await client.session.listSessionTurns({ sessionId: "gone" });
    expect(session).toBeNull();
    expect(turns).toStrictEqual([]);

    // 发消息先过模型查找，再轮到会话自己的判断：行还在但已经删掉，不能当成
    // 「已存在」放行，否则一条旧消息会把它唤醒成一次看不见的运行。
    await expect(
      client.session.createSession({
        sessionId: "gone",
        turns: [userTurn("turn-gone", "再来一句")],
        model: { providerId: "test-provider", modelId: "test-model" },
      })
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  test("should refuse while a run is live, and take the session once stopped", async () => {
    const hanging = await startHangingProvider();

    try {
      await client.setting.update(provider(hanging.baseURL));

      await client.session.createSession({
        sessionId: "live",
        turns: [userTurn("turn-live", "跑起来")],
        model: { providerId: "test-provider", modelId: "test-model" },
      });

      await waitFor(async () => {
        const { session: running } = await client.session.getSession({
          sessionId: "live",
        });
        return running?.status === "running";
      });

      await expect(
        client.session.deleteSession({ sessionId: "live" })
      ).rejects.toMatchObject({ code: "SESSION_BUSY" });

      // 停是它自己的入口：运行不能被一条删除请求带走，停了之后删除才成立。
      await client.session.stopSession({ sessionId: "live" });
      await expect(
        client.session.deleteSession({ sessionId: "live" })
      ).resolves.toStrictEqual({ sessionId: "live", removed: true });
    } finally {
      await hanging.close();
      await client.setting.update(provider("http://127.0.0.1:9/v1"));
    }
  });

  test("should take a session that waits for review", async () => {
    // 待审批不是运行：审批住在转录里，恢复之后还能回答，所以删除不该被它挡住。
    await seedSession("reviewing", "辛", { status: "wait_review" });

    await expect(
      client.session.deleteSession({ sessionId: "reviewing" })
    ).resolves.toStrictEqual({ sessionId: "reviewing", removed: true });
  });

  test("should stop the background jobs the session owns", async () => {
    const { JOB_REGISTRY } = await import("../src/jobs");
    await seedSession("with-job", "戊");

    let cancelled = false;
    let settle!: (outcome: { status: "killed"; detail: string }) => void;
    const done = new Promise<{ status: "killed"; detail: string }>(
      (resolve) => {
        settle = resolve;
      }
    );

    JOB_REGISTRY.start({
      kind: "bash",
      label: "sleep 60",
      owner: "with-job",
      run: () => ({
        cancel: (reason) => {
          cancelled = true;
          settle({ status: "killed", detail: reason ?? "" });
        },
        done,
      }),
    });

    expect(JOB_REGISTRY.list("with-job")).toHaveLength(1);

    await client.session.deleteSession({ sessionId: "with-job" });

    expect(cancelled).toBeTruthy();
    expect(JOB_REGISTRY.list("with-job")).toStrictEqual([]);
  });

  test("should refuse the event stream of a deleted session", async () => {
    await seedSession("gone-events", "庚");
    await client.session.deleteSession({ sessionId: "gone-events" });

    // 旧标签页挂着一条连接，服务端却已经把这个会话视为不存在：连接不该建立。
    await expect(
      client.session.streamSessionEvents({ sessionId: "gone-events" })
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  test("should let a brand-new session subscribe before its row exists", async () => {
    // 页面先订阅、消息到了才落行：那时还没有会话行，但订阅是合法的。
    const events = await client.session.streamSessionEvents({
      sessionId: "not-yet-created",
    });
    expect(events).toBeDefined();

    const iterator = events[Symbol.asyncIterator]();
    await iterator.return?.();
  });

  /**
   * 每条带 `sessionId` 的表都得表态：跟着会话一起清，还是留着。
   *
   * 这是「以后又加了一张表」的报警器。没有外键兜底，漏一张只在库里留残行——不会
   * 报错，也没人看得见。新表要么进清扫清单，要么进保留清单并写清理由，否则这里红。
   */
  test("should classify every table that carries a session id", async () => {
    const { getTableColumns, getTableName, is } = await import("drizzle-orm");
    const { SQLiteTable } = await import("drizzle-orm/sqlite-core");
    const schema = await import("@workspace/db");

    const tables = Object.values(schema).filter((value) =>
      is(value, SQLiteTable)
    );
    const sessionScoped = tables
      .filter((table) => "sessionId" in getTableColumns(table))
      .map((table) => getTableName(table));

    // 跟着会话一起清：这些都是「将来还会发生的事」。
    const purged = new Set(["inbox_item", "outbox_item", "timer"]);
    // 留着：转录本身，回收站要恢复的就是它。
    const kept = new Set(["turn", "step"]);

    expect(new Set(sessionScoped)).toStrictEqual(new Set([...purged, ...kept]));
  });
});
