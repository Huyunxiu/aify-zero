import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTimerScheduler } from "../../src/timers/scheduler.js";
import type { FiredTimer, Timer, TimerStore } from "../../src/timers/types.js";

const SCAN_MS = 60_000;

const timer = (id: string, sessionId = "session-1"): Timer => ({
  id,
  sessionId,
  toolCallId: `call-${id}`,
  note: `note ${id}`,
  dueAt: 1000,
  recurrence: null,
  payload: { model: { providerId: "p", modelId: "m" } },
  createdAt: 0,
});

type FakeStore = TimerStore & {
  /** `fireDueTimers` 被调了几次。 */
  scans: number;
  /** 每次调用时的 `now`。 */
  times: number[];
  /** 此刻是否已经返回；用来证明唤醒发生在提交之后。 */
  settled: boolean;
  pending: number;
  /** 前几次调用要抛的错；用完之后照常返回。 */
  failures: number;
  due: Timer[];
};

const createStore = (due: Timer[] = []): FakeStore => {
  const store: FakeStore = {
    scans: 0,
    times: [],
    settled: false,
    pending: due.length,
    failures: 0,
    due,
    insertTimer: () => Promise.reject(new Error("not used")),
    listTimers: () => Promise.resolve([]),
    cancelTimer: () => Promise.resolve(false),
    timerCounts: () =>
      Promise.resolve({ pending: store.pending, pendingSchedules: 0 }),
    fireDueTimers: (now) => {
      store.scans += 1;
      store.times.push(now);

      if (store.failures > 0) {
        store.failures -= 1;
        return Promise.reject(new Error("database is locked"));
      }

      const fired: FiredTimer[] = store.due.map((entry) => ({
        ...entry,
        firedAt: now,
        nextDueAt: null,
      }));
      store.due = [];
      store.pending = 0;
      store.settled = true;
      return Promise.resolve(fired);
    },
  };

  return store;
};

/** 让排队的微任务跑完。 */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("TimerScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("scans once on start, so a timer that expired while down is delivered", async () => {
    const store = createStore([timer("a")]);
    const scheduler = createTimerScheduler({
      store,
      wake: () => {},
      now: () => 5000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.scans).toBe(1);
    expect(store.times).toStrictEqual([5000]);

    await scheduler.stop();
  });

  test("wakes each session once, after the store returned", async () => {
    const store = createStore([
      timer("a", "session-1"),
      timer("b", "session-1"),
    ]);
    const woke: { sessionId: string; settled: boolean }[] = [];

    const scheduler = createTimerScheduler({
      store,
      wake: (sessionId) => woke.push({ sessionId, settled: store.settled }),
      now: () => 5000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(woke).toStrictEqual([{ sessionId: "session-1", settled: true }]);

    await scheduler.stop();
  });

  test("keeps scanning after a failed scan", async () => {
    const store = createStore([timer("a")]);
    store.failures = 1;
    const warned: string[] = [];

    const scheduler = createTimerScheduler({
      store,
      wake: () => {},
      now: () => 5000,
      warn: (message) => warned.push(message),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.scans).toBe(1);
    expect(warned).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(SCAN_MS);
    expect(store.scans).toBe(2);

    await scheduler.stop();
  });

  test("reports what it is doing", async () => {
    const store = createStore([timer("a")]);
    const scheduler = createTimerScheduler({
      store,
      wake: () => {},
      now: () => 5000,
      intervalMs: 30_000,
    });

    await expect(scheduler.state()).resolves.toMatchObject({
      intervalMs: 30_000,
      pending: 1,
      pendingSchedules: 0,
      lastScanAt: null,
      lastFired: 0,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    await expect(scheduler.state()).resolves.toMatchObject({
      pending: 0,
      lastScanAt: 5000,
      lastFired: 1,
    });

    await scheduler.stop();
  });

  test("stops scanning after stop", async () => {
    const store = createStore();
    const scheduler = createTimerScheduler({ store, wake: () => {} });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();

    const before = store.scans;
    await vi.advanceTimersByTimeAsync(SCAN_MS * 3);
    expect(store.scans).toBe(before);
  });

  test("rejects a non-positive interval", () => {
    const store = createStore();

    expect(() =>
      createTimerScheduler({ store, wake: () => {}, intervalMs: 0 })
    ).toThrow(/invalid timer scan interval/);
  });

  test("does not scan while the previous scan is still running", async () => {
    const store = createStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    store.fireDueTimers = async () => {
      store.scans += 1;
      await gate;
      return [];
    };

    const scheduler = createTimerScheduler({ store, wake: () => {} });
    scheduler.start();
    await flush();

    // 第一轮还卡在 gate 上；这期间的两次 tick 都该被跳过。
    await vi.advanceTimersByTimeAsync(SCAN_MS * 2);
    expect(store.scans).toBe(1);

    release();
    await flush();

    await vi.advanceTimersByTimeAsync(SCAN_MS);
    expect(store.scans).toBe(2);

    await scheduler.stop();
  });
});
