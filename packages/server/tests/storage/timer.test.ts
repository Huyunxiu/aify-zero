import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RecurrenceRule } from "@workspace/agent/store";
import { beforeAll, describe, expect, test } from "vitest";

import type { SQLiteStore } from "../../src/storage/sqlite-store.js";
import { userTurn } from "../helpers/compaction-fixtures.js";

// `@workspace/db` 在导入时就按 `DATABASE_URL` 建连接，所以选库必须发生在它
// 被加载之前；这里先设环境变量，再在 `beforeAll` 里动态导入。
const dir = mkdtempSync(path.join(tmpdir(), "aify-timer-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

let store: SQLiteStore;

const SESSION = "session-1";
const NOW = 1_000_000;

const payload = { model: { providerId: "p", modelId: "m" } };

const set = async (overrides: {
  sessionId?: string;
  toolCallId?: string;
  dueAt?: number;
  note?: string;
  recurrence?: RecurrenceRule | null;
}) =>
  await store.insertTimer({
    sessionId: overrides.sessionId ?? SESSION,
    toolCallId: overrides.toolCallId ?? "call-1",
    note: overrides.note ?? "check the deploy",
    dueAt: overrides.dueAt ?? NOW + 60_000,
    recurrence: overrides.recurrence ?? null,
    payload,
  });

/** 一条每天九点的日程。 */
const DAILY: RecurrenceRule = {
  type: "daily",
  at: "09:00",
  timeZone: "UTC",
};

describe("timer storage", () => {
  beforeAll(async () => {
    const { migrateDb } = await import("@workspace/db");
    await migrateDb();

    const { SQLiteStore } = await import("../../src/storage/sqlite-store.js");
    store = new SQLiteStore();
  });

  test("stores a timer and lists it by due time", async () => {
    const session = "session-list";
    const later = await set({
      sessionId: session,
      toolCallId: "call-later",
      dueAt: NOW + 120_000,
      note: "later",
    });
    const sooner = await set({
      sessionId: session,
      toolCallId: "call-sooner",
      dueAt: NOW + 60_000,
      note: "sooner",
    });

    const listed = await store.listTimers(session);

    expect(listed.map((timer) => timer.id)).toStrictEqual([
      sooner.id,
      later.id,
    ]);
    expect(listed[0]?.note).toBe("sooner");
    expect(listed[0]?.payload).toStrictEqual(payload);
  });

  test("returns the same timer when the tool call is retried", async () => {
    const session = "session-retry";
    const first = await set({ sessionId: session, toolCallId: "call-x" });
    const second = await set({ sessionId: session, toolCallId: "call-x" });

    expect(second.id).toBe(first.id);
    await expect(store.listTimers(session)).resolves.toHaveLength(1);
  });

  test("refuses the ninth timer in a session", async () => {
    const session = "session-limit";

    for (let index = 0; index < 8; index += 1) {
      await set({ sessionId: session, toolCallId: `call-${index}` });
    }

    await expect(
      set({ sessionId: session, toolCallId: "call-9" })
    ).rejects.toMatchObject({ code: "TIMER_LIMIT_REACHED" });
  });

  test("cancels a timer once", async () => {
    const session = "session-cancel";
    const timer = await set({ sessionId: session });

    await expect(store.cancelTimer(session, timer.id)).resolves.toBeTruthy();
    await expect(store.cancelTimer(session, timer.id)).resolves.toBeFalsy();
    await expect(store.listTimers(session)).resolves.toHaveLength(0);
  });

  test("does not cancel a timer of another session", async () => {
    const timer = await set({ sessionId: "session-a", toolCallId: "call-a" });

    await expect(store.cancelTimer("session-b", timer.id)).resolves.toBeFalsy();
  });

  test("fires a due timer into the inbox and drops the row", async () => {
    const session = "session-fire";
    const timer = await set({
      sessionId: session,
      dueAt: NOW - 1,
      note: "check the deploy",
    });

    const fired = await store.fireDueTimers(NOW);

    expect(fired.map((entry) => entry.id)).toContain(timer.id);
    await expect(store.listTimers(session)).resolves.toHaveLength(0);

    const items = await store.listInboxItems(session);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("timer");
  });

  test("writes a fired timer as a run-boundary turn with its own source", async () => {
    const session = "session-turn";
    await set({ sessionId: session, dueAt: NOW - 1, note: "check the deploy" });
    await store.fireDueTimers(NOW);

    const [item] = await store.listInboxItems(session);

    expect(item?.deliverAt).toBe("run-boundary");
    expect(item?.payload).toStrictEqual(payload);

    const [step] = item?.content.content ?? [];
    expect(step?.source).toBe("timer");
    expect(step?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("check the deploy"),
    });
  });

  test("leaves a timer that is not due yet", async () => {
    const session = "session-future";
    await set({ sessionId: session, dueAt: NOW + 60_000 });

    await expect(store.fireDueTimers(NOW)).resolves.toHaveLength(0);
    await expect(store.listTimers(session)).resolves.toHaveLength(1);
  });

  test("fires each timer only once", async () => {
    const session = "session-once";
    await set({ sessionId: session, dueAt: NOW - 1 });

    await expect(store.fireDueTimers(NOW)).resolves.toHaveLength(1);
    await expect(store.fireDueTimers(NOW)).resolves.toHaveLength(0);
    await expect(store.listInboxItems(session)).resolves.toHaveLength(1);
  });

  test("keeps one inbox item when the same timer id is already queued", async () => {
    // 两个进程同时扫到同一条到期项时，后到的那个会撞上 (session_id, dedupe_key)：
    // 投递仍然只有一条，定时器行照样消失。
    const session = "session-dup";
    const timer = await set({
      sessionId: session,
      dueAt: NOW - 1,
      note: "check",
    });
    await store.insertInboxItem({
      sessionId: session,
      kind: "timer",
      dedupeKey: `timer:${timer.id}`,
      deliverAt: "run-boundary",
      content: userTurn("turn-dup", "timer fired"),
      payload,
    });

    const fired = await store.fireDueTimers(NOW);

    expect(fired).toHaveLength(1);
    await expect(store.listTimers(session)).resolves.toHaveLength(0);
    await expect(store.listInboxItems(session)).resolves.toHaveLength(1);
  });

  test("counts every pending timer across sessions", async () => {
    const before = await store.timerCounts();
    await set({ sessionId: "session-count", toolCallId: "call-count" });

    await expect(store.timerCounts()).resolves.toMatchObject({
      pending: before.pending + 1,
      pendingSchedules: before.pendingSchedules,
    });
  });

  test("counts schedules inside the same budget", async () => {
    const before = await store.timerCounts();
    await set({
      sessionId: "session-count-schedule",
      toolCallId: "call-count-schedule",
      recurrence: DAILY,
    });

    await expect(store.timerCounts()).resolves.toMatchObject({
      pending: before.pending + 1,
      pendingSchedules: before.pendingSchedules + 1,
    });
  });
});

describe("schedule storage", () => {
  test("advances a due schedule instead of dropping it", async () => {
    const session = "session-schedule-advance";
    const timer = await set({
      sessionId: session,
      dueAt: NOW - 1,
      note: "write the report",
      recurrence: DAILY,
    });

    const fired = await store.fireDueTimers(NOW);

    expect(fired).toHaveLength(1);
    await expect(store.listInboxItems(session)).resolves.toHaveLength(1);

    const [kept] = await store.listTimers(session);
    expect(kept?.id).toBe(timer.id);
    expect(kept?.dueAt).toBe(fired[0]?.nextDueAt);
    expect(kept?.dueAt).toBeGreaterThan(NOW);
  });

  test("collapses missed firings into one and keeps the phase", async () => {
    // 停机三天：只投一次，下一次仍然落在原来的节拍上。
    const session = "session-schedule-catchup";
    const everySeconds = 3600;
    const dueAt = NOW - 3 * 24 * 60 * 60_000;
    await set({
      sessionId: session,
      dueAt,
      recurrence: { type: "interval", everySeconds },
    });

    const fired = await store.fireDueTimers(NOW);

    expect(fired).toHaveLength(1);
    await expect(store.listInboxItems(session)).resolves.toHaveLength(1);

    const [kept] = await store.listTimers(session);
    const next = kept?.dueAt ?? 0;
    expect(next).toBeGreaterThan(NOW);
    expect((next - dueAt) % (everySeconds * 1000)).toBe(0);
  });

  test("writes the next firing into the notice", async () => {
    const session = "session-schedule-notice";
    await set({
      sessionId: session,
      dueAt: NOW - 1,
      note: "write the report",
      recurrence: DAILY,
    });

    await store.fireDueTimers(NOW);

    const [item] = await store.listInboxItems(session);
    const [step] = item?.content.content ?? [];
    const [part] = step?.content ?? [];

    expect(part).toMatchObject({ type: "text" });
    expect(part).toMatchObject({
      text: expect.stringContaining("daily 09:00 UTC"),
    });
    expect(part).toMatchObject({ text: expect.stringContaining("Next:") });
    expect(part).toMatchObject({
      text: expect.stringContaining("write the report"),
    });
  });

  test("folds a second firing into the notice that is still queued", async () => {
    // 会话闲置（或正在跑）时，前一条通知还没被领走。两次触发不能各落一行：一次
    // 运行会把它们一起领走，模型就收到两条说同一件事的通知。
    const session = "session-schedule-fold";
    const timer = await set({
      sessionId: session,
      dueAt: NOW - 1,
      recurrence: DAILY,
    });

    await store.fireDueTimers(NOW);
    await expect(store.listInboxItems(session)).resolves.toHaveLength(1);

    const [advanced] = await store.listTimers(session);
    await store.fireDueTimers((advanced?.dueAt ?? 0) + 60_000);

    const items = await store.listInboxItems(session);
    expect(items).toHaveLength(1);
    expect(items[0]?.dedupeKey).toBe(`timer:${timer.id}`);
  });

  test("drops a schedule whose rule cannot advance instead of jamming the scan", async () => {
    // 旧版本或手改的库可能留下这个版本读不懂的规则。它每次都会算失败；不处理的话
    // 事务每次回滚，所有定时器都不再触发。
    const session = "session-schedule-broken";
    await set({
      sessionId: session,
      dueAt: NOW - 1,
      recurrence: { type: "monthly", at: "09:00" } as unknown as RecurrenceRule,
    });
    const followUp = await set({
      sessionId: "session-schedule-broken-other",
      toolCallId: "call-other",
      dueAt: NOW - 1,
    });

    const fired = await store.fireDueTimers(NOW);

    expect(fired.map((entry) => entry.id)).toContain(followUp.id);
    await expect(store.listTimers(session)).resolves.toHaveLength(0);
    await expect(store.listInboxItems(session)).resolves.toHaveLength(1);
  });

  test("cancels a schedule so it never fires again", async () => {
    const session = "session-schedule-cancel";
    const timer = await set({
      sessionId: session,
      dueAt: NOW - 1,
      recurrence: DAILY,
    });

    await expect(store.cancelTimer(session, timer.id)).resolves.toBeTruthy();
    await expect(store.fireDueTimers(NOW)).resolves.toHaveLength(0);
  });
});
