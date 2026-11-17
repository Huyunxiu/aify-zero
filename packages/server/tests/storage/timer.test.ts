import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
}) =>
  await store.insertTimer({
    sessionId: overrides.sessionId ?? SESSION,
    toolCallId: overrides.toolCallId ?? "call-1",
    note: overrides.note ?? "check the deploy",
    dueAt: overrides.dueAt ?? NOW + 60_000,
    payload,
  });

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
    const before = await store.countTimers();
    await set({ sessionId: "session-count", toolCallId: "call-count" });

    await expect(store.countTimers()).resolves.toBe(before + 1);
  });
});
