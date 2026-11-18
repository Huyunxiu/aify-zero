import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentToolSet } from "@workspace/agent";
import type { AgentStep, AgentTurn } from "@workspace/agent-client";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";

import { deliveryBody } from "../src/outbox/snippet.js";
import type { SQLiteStore } from "../src/storage/sqlite-store.js";

// `@workspace/db` 在导入时就按 `DATABASE_URL` 建连接，所以选库必须发生在它
// 被加载之前；这里先设环境变量，再在 `beforeAll` 里动态导入。
const dir = mkdtempSync(path.join(tmpdir(), "aify-outbox-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

const NOW = 1_700_000_000_000;

/** 动态导入的数据库模块；类型从加载函数推断，免得写 `import()` 注解。 */
const loadDb = async () => await import("@workspace/db");

let store: SQLiteStore;
let tables: Awaited<ReturnType<typeof loadDb>>;

const assistantStep = (stepId: string, text: string): AgentStep<AgentToolSet> =>
  ({
    content: [{ createdAt: NOW, text, type: "text" }],
    createdAt: NOW,
    id: stepId,
    model: "fake",
    status: "done",
    type: "assistant",
  }) as AgentStep<AgentToolSet>;

/**
 * 种一个会话、一个回合和它的 step。
 *
 * 这里刻意走存储自己的写入口，而不是直接 INSERT：`getTurnRecord` 读的正是
 * 这些行，种进去的形状不对，用例就没有意义。
 */
const seedTurn = async (input: {
  sessionId: string;
  status?: "done" | "idle" | "running";
  text: string;
  turnId: string;
}): Promise<void> => {
  const { status = "done", sessionId, text, turnId } = input;

  await store.saveSession({
    id: sessionId,
    metadata: {},
    status,
    title: "Fix the build",
  });

  await store.saveTurn(
    {
      content: {
        content: [],
        createdAt: NOW,
        id: turnId,
        status: "done",
        type: "assistant",
      } as AgentTurn<AgentToolSet>,
      createdAt: new Date(NOW),
      id: turnId,
      metadata: {},
      parentId: null,
      sessionId,
      type: "assistant",
    },
    { head: true }
  );

  await store.saveStep({
    content: assistantStep(`${turnId}-step`, text),
    createdAt: new Date(NOW),
    seq: 1,
    sessionId,
    status: "done",
    stepId: `${turnId}-step`,
    streamId: null,
    turnId,
    type: "assistant",
    updatedAt: new Date(NOW),
  });
};

describe("outbox storage", () => {
  beforeAll(async () => {
    tables = await loadDb();
    await tables.migrateDb();

    const { SQLiteStore } = await import("../src/storage/sqlite-store.js");
    store = new SQLiteStore();
  });

  test("reads a delivery body out of the turn it stored", async () => {
    await seedTurn({
      sessionId: "session-body",
      text: "all tests pass",
      turnId: "turn-body",
    });

    // 这条断言走的是真实存储 + 真实 `hydrateTurn`：正文取错层级时它会是空串，
    // 而这正是评审里那个「永远不弹通知」的根因。
    const record = await store.getTurnRecord("session-body", "turn-body");

    expect(record).not.toBeNull();
    expect(deliveryBody(record?.content)).toBe("all tests pass");
  });

  test("returns null for a turn that is not there", async () => {
    await expect(
      store.getTurnRecord("session-body", "turn-missing")
    ).resolves.toBeNull();
  });

  test("lists a settled session's row and skips a session someone read", async () => {
    await seedTurn({
      sessionId: "session-done",
      text: "done",
      turnId: "turn-done",
    });
    await seedTurn({
      sessionId: "session-read",
      status: "idle",
      text: "done",
      turnId: "turn-read",
    });

    await store.recordOutboxItem({
      sessionId: "session-done",
      turnId: "turn-done",
    });
    await store.recordOutboxItem({
      sessionId: "session-read",
      turnId: "turn-read",
    });

    const candidates = await store.listOutboxCandidates({
      before: Date.now() + 1,
      limit: 10,
      since: 0,
    });

    expect(candidates.map((row) => row.sessionId)).toStrictEqual([
      "session-done",
    ]);
    expect(candidates[0]?.title).toBe("Fix the build");
  });

  test("marking a session read retires its pending outbox rows", async () => {
    await seedTurn({
      sessionId: "session-seen",
      text: "done",
      turnId: "turn-seen",
    });
    await store.recordOutboxItem({
      sessionId: "session-seen",
      turnId: "turn-seen",
    });

    await store.markSessionRead("session-seen");

    const [row] = await tables.db
      .select()
      .from(tables.outbox_item_table)
      .where(eq(tables.outbox_item_table.sessionId, "session-seen"));

    // 人已经在转录里看到了：这一行不能再弹。回执与过期是两件事，这里只写过期。
    expect(row?.expiredAt).toBeInstanceOf(Date);
    expect(row?.deliveredAt).toBeNull();
  });

  test("a read that changes no status leaves pending rows alone", async () => {
    await seedTurn({
      sessionId: "session-running",
      status: "running",
      text: "still working",
      turnId: "turn-running",
    });
    await store.recordOutboxItem({
      sessionId: "session-running",
      turnId: "turn-running",
    });

    const updated = await store.markSessionRead("session-running");

    const [row] = await tables.db
      .select()
      .from(tables.outbox_item_table)
      .where(eq(tables.outbox_item_table.sessionId, "session-running"));

    // 没从 `done` 走回 `idle`，就什么都没发生：正在跑的会话不能被读掉。
    expect(updated).toBe(0);
    expect(row?.expiredAt).toBeNull();
  });

  test("a row inside the race window waits for the next sweep", async () => {
    await seedTurn({
      sessionId: "session-race",
      text: "done",
      turnId: "turn-race",
    });
    await store.recordOutboxItem({
      sessionId: "session-race",
      turnId: "turn-race",
    });

    const [row] = await tables.db
      .select()
      .from(tables.outbox_item_table)
      .where(eq(tables.outbox_item_table.sessionId, "session-race"));

    // 到达时刻是毫秒：截止线早于它就不会被取走。
    expect(row?.createdAt).toBeInstanceOf(Date);

    const candidates = await store.listOutboxCandidates({
      before: (row?.createdAt?.getTime() ?? 0) - 1,
      limit: 10,
      since: 0,
    });

    expect(
      candidates.some((candidate) => candidate.sessionId === "session-race")
    ).toBeFalsy();
  });

  test("stamps expiry with the moment it gave up, not the deadline", async () => {
    await seedTurn({
      sessionId: "session-expire",
      text: "done",
      turnId: "turn-expire",
    });
    await store.recordOutboxItem({
      sessionId: "session-expire",
      turnId: "turn-expire",
    });

    const now = Date.now();
    const deadline = now - 600_000;

    // 只有「早于截止线到达」的行才会过期：把这一行退到十分钟以前。
    await tables.db
      .update(tables.outbox_item_table)
      .set({ createdAt: new Date(deadline - 1000) })
      .where(eq(tables.outbox_item_table.sessionId, "session-expire"));

    await store.expireOutboxBefore({ deadline, now });

    const [row] = await tables.db
      .select()
      .from(tables.outbox_item_table)
      .where(eq(tables.outbox_item_table.sessionId, "session-expire"));

    expect(row?.expiredAt?.getTime()).toBeGreaterThan(deadline);
    expect(row?.deliveredAt).toBeNull();
  });

  test("records one row per turn when the same turn is recorded twice", async () => {
    await seedTurn({
      sessionId: "session-twice",
      text: "done",
      turnId: "turn-twice",
    });
    await store.recordOutboxItem({
      sessionId: "session-twice",
      turnId: "turn-twice",
    });
    await store.recordOutboxItem({
      sessionId: "session-twice",
      turnId: "turn-twice",
    });

    const rows = await tables.db
      .select()
      .from(tables.outbox_item_table)
      .where(eq(tables.outbox_item_table.sessionId, "session-twice"));

    expect(rows).toHaveLength(1);
  });

  test("counts the rows that are neither delivered nor expired", async () => {
    // 前面几条用例各自留了待投的行，所以这里只断言增减，不咬死总数。
    await seedTurn({
      sessionId: "session-count",
      text: "done",
      turnId: "turn-count",
    });
    const before = await store.countPendingOutbox();

    await store.recordOutboxItem({
      sessionId: "session-count",
      turnId: "turn-count",
    });
    await expect(store.countPendingOutbox()).resolves.toBe(before + 1);

    const [row] = await tables.db
      .select()
      .from(tables.outbox_item_table)
      .where(eq(tables.outbox_item_table.sessionId, "session-count"));

    if (!row) {
      throw new Error("the row was not recorded");
    }

    // 盖上回执之后它就不算等着了；只读状态报的就是这个数。
    await store.markOutboxDelivered([row.id], Date.now());
    await expect(store.countPendingOutbox()).resolves.toBe(before);
  });
});
