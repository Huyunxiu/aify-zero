import { describe, expect, test } from "vitest";

import type { ToolEnvironment } from "../../src/extensions/capabilities.js";
import { TimerError } from "../../src/timers/error.js";
import { resolveRecurrence } from "../../src/timers/recurrence.js";
import type { SessionTimers, Timer } from "../../src/timers/types.js";
import { createTimerTools } from "../../src/tools/timers.js";

const timer = (overrides: Partial<Timer> = {}): Timer => ({
  id: "timer-1",
  sessionId: "session-1",
  toolCallId: "call-1",
  note: "check the deploy",
  dueAt: 600_000,
  recurrence: null,
  payload: { model: { providerId: "p", modelId: "m" } },
  createdAt: 0,
  ...overrides,
});

type Timers = SessionTimers & {
  /** 每次 `set` 的入参。 */
  sets: { toolCallId: string; note: string; dueAt: number }[];
  /** 每次 `setSchedule` 的入参。 */
  schedules: {
    toolCallId: string;
    note: string;
    recurrence: Parameters<SessionTimers["setSchedule"]>[0]["recurrence"];
  }[];
  /** `list` 要返回的内容。 */
  pending: Timer[];
  /** `set` 要抛的错。 */
  failure?: Error;
};

const createTimers = (pending: Timer[] = []): Timers => {
  const timers: Timers = {
    sets: [],
    schedules: [],
    pending,
    set: (input) => {
      timers.sets.push(input);
      if (timers.failure !== undefined) {
        return Promise.reject(timers.failure);
      }
      return Promise.resolve(timer({ dueAt: input.dueAt, note: input.note }));
    },
    setSchedule: (input) => {
      timers.schedules.push(input);
      if (timers.failure !== undefined) {
        return Promise.reject(timers.failure);
      }
      // 绑定处会用装配时区补齐；这里照做，工具拿到的就是能存的那一条。
      const recurrence = resolveRecurrence(input.recurrence, "Asia/Shanghai");
      return Promise.resolve(
        timer({
          id: "schedule-1",
          note: input.note,
          dueAt: Date.now() + 3_600_000,
          recurrence,
        })
      );
    },
    list: () => Promise.resolve(timers.pending),
    cancel: (id) => Promise.resolve(id === "timer-1"),
  };

  return timers;
};

const createEnvironment = (timers: SessionTimers): ToolEnvironment =>
  ({
    sessionId: "session-1",
    projectDirs: ["/tmp"],
    primaryProjectDir: "/tmp",
    sessionDir: "/tmp/sessions/session-1",
    timers,
  }) as unknown as ToolEnvironment;

type ToolResult = { output: string; code: string };

const call = async (
  entry: { execute?: (input: never, options: never) => unknown },
  input: unknown,
  toolCallId = "call-1"
): Promise<ToolResult> => {
  const { execute } = entry;
  if (execute === undefined) {
    throw new TypeError("timer tool has no execute function");
  }

  return (await execute(
    input as never,
    {
      toolCallId,
      messages: [],
    } as never
  )) as ToolResult;
};

const tools = (timers: SessionTimers) =>
  createTimerTools({ agentContext: createEnvironment(timers) });

type Parseable = {
  safeParse: (value: unknown) => { success: boolean };
};

const timerSetSchema = (): Parseable & { shape: unknown } =>
  tools(createTimers())["timer-set"].inputSchema as unknown as Parseable & {
    shape: unknown;
  };

/** 入参过不过 schema；越界在 SDK 里就是一次参数校验失败。 */
const parses = (input: unknown): boolean =>
  (timerSetSchema() as unknown as Parseable).safeParse(input).success;

describe("timer-set", () => {
  test("turns the delay into a due time and keeps the tool call id", async () => {
    const timers = createTimers();
    const before = Date.now();

    const result = await call(tools(timers)["timer-set"], {
      note: "check the deploy",
      afterSeconds: 600,
    });

    expect(result.code).toBe("ok");
    expect(timers.sets).toHaveLength(1);
    expect(timers.sets[0]?.toolCallId).toBe("call-1");
    expect(timers.sets[0]?.note).toBe("check the deploy");
    expect(timers.sets[0]?.dueAt).toBeGreaterThanOrEqual(before + 600_000);
  });

  test("says the timer is not a precise alarm", async () => {
    const result = await call(tools(createTimers())["timer-set"], {
      note: "check",
      afterSeconds: 60,
    });

    expect(result.output).toContain("up to one minute late");
  });

  test("surfaces the limit as a typed failure", async () => {
    const timers = createTimers();
    timers.failure = new TimerError("too many", "TIMER_LIMIT_REACHED");

    await expect(
      call(tools(timers)["timer-set"], { note: "check", afterSeconds: 60 })
    ).rejects.toThrow(/TIMER_LIMIT_REACHED/);
  });

  test("requires a note in the schema, so the model always writes one", () => {
    // 入参校验由 AI SDK 在调用 execute 之前做，所以这里只看 schema 自己。
    expect(timerSetSchema()).toMatchObject({
      shape: { note: { minLength: 1 } },
    });
  });

  test("caps the note at 200 characters", () => {
    expect(parses({ note: "x".repeat(200), afterSeconds: 60 })).toBeTruthy();
    expect(parses({ note: "x".repeat(201), afterSeconds: 60 })).toBeFalsy();
  });

  test("bounds the delay to one minute and one day", () => {
    expect(parses({ note: "check", afterSeconds: 59 })).toBeFalsy();
    expect(parses({ note: "check", afterSeconds: 60 })).toBeTruthy();
    expect(parses({ note: "check", afterSeconds: 86_400 })).toBeTruthy();
    expect(parses({ note: "check", afterSeconds: 86_401 })).toBeFalsy();
  });
});

describe("timer-list", () => {
  test("says so when nothing is pending", async () => {
    const result = await call(tools(createTimers())["timer-list"], {});

    expect(result.output).toBe("(no pending timers)");
  });

  test("lists id, delay and note", async () => {
    const timers = createTimers([
      timer({
        id: "timer-1",
        note: "check the deploy",
        dueAt: Date.now() + 600_000,
      }),
      timer({
        id: "timer-2",
        note: "read the build log",
        dueAt: Date.now() + 120_000,
      }),
    ]);

    const result = await call(tools(timers)["timer-list"], {});

    expect(result.output).toContain("timer-1");
    expect(result.output).toContain("check the deploy");
    expect(result.output).toContain("timer-2");
    expect(result.output.split("\n")).toHaveLength(2);
  });
});

describe("timer-cancel", () => {
  test("reports a timer it removed", async () => {
    const result = await call(tools(createTimers())["timer-cancel"], {
      timerId: "timer-1",
    });

    expect(result.output).toContain("cancelled timer timer-1");
  });

  test("says a missing timer may have fired", async () => {
    const result = await call(tools(createTimers())["timer-cancel"], {
      timerId: "timer-9",
    });

    expect(result.output).toContain("may have already fired");
  });
});

describe(createTimerTools, () => {
  test("refuses to build without session timers", () => {
    expect(() =>
      createTimerTools({
        agentContext: { sessionId: "s" } as unknown as ToolEnvironment,
      })
    ).toThrow(/session timers/);
  });
});

const scheduleSchema = (): Parseable & { shape: unknown } =>
  tools(createTimers())["schedule-set"].inputSchema as unknown as Parseable & {
    shape: unknown;
  };

const parsesSchedule = (input: unknown): boolean =>
  (scheduleSchema() as unknown as Parseable).safeParse(input).success;

describe("schedule-set", () => {
  const daily = {
    note: "write the daily report",
    recurrence: { type: "daily", at: "09:00" },
  };

  test("hands the rule to the session view and says what will fire", async () => {
    const timers = createTimers();

    const result = await call(tools(timers)["schedule-set"], daily);

    expect(timers.schedules).toHaveLength(1);
    expect(timers.schedules[0]?.toolCallId).toBe("call-1");
    expect(result.output).toContain("schedule schedule-1 set");
    expect(result.output).toContain("daily 09:00 Asia/Shanghai");
  });

  test("says the schedule is not a precise alarm", async () => {
    const result = await call(tools(createTimers())["schedule-set"], daily);

    expect(result.code).toBe("ok");
    expect(result.output).toContain("up to one minute late");
  });

  test("keeps an explicit time zone", async () => {
    const timers = createTimers();

    await call(tools(timers)["schedule-set"], {
      note: "standup",
      recurrence: { type: "daily", at: "09:00", timeZone: "Europe/Berlin" },
    });

    expect(timers.schedules[0]?.recurrence).toMatchObject({
      timeZone: "Europe/Berlin",
    });
  });

  test("says a weekday set in plain words", async () => {
    const result = await call(tools(createTimers())["schedule-set"], {
      note: "standup",
      recurrence: { type: "weekly", at: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });

    expect(result.output).toContain("every weekday 09:00 Asia/Shanghai");
  });

  test("surfaces the limit as a typed failure", async () => {
    const timers = createTimers();
    timers.failure = new TimerError("too many", "TIMER_LIMIT_REACHED");

    await expect(call(tools(timers)["schedule-set"], daily)).rejects.toThrow(
      /TIMER_LIMIT_REACHED/
    );
  });

  test("requires one of the three rule shapes", () => {
    expect(parsesSchedule(daily)).toBeTruthy();
    expect(
      parsesSchedule({
        note: "x",
        recurrence: { type: "monthly", at: "09:00" },
      })
    ).toBeFalsy();
  });

  test("rejects an unknown time zone", () => {
    expect(
      parsesSchedule({
        note: "x",
        recurrence: { type: "daily", at: "09:00", timeZone: "Mars/Olympus" },
      })
    ).toBeFalsy();
  });

  test("keeps the interval at or above the scan floor", () => {
    expect(
      parsesSchedule({
        note: "x",
        recurrence: { type: "interval", everySeconds: 299 },
      })
    ).toBeFalsy();
    expect(
      parsesSchedule({
        note: "x",
        recurrence: { type: "interval", everySeconds: 300 },
      })
    ).toBeTruthy();
  });

  test("requires at least one weekday", () => {
    expect(
      parsesSchedule({
        note: "x",
        recurrence: { type: "weekly", at: "09:00", weekdays: [] },
      })
    ).toBeFalsy();
  });
});

describe("timer-list with schedules", () => {
  test("shows the rule so two rows are not just ids", () => {
    const timers = createTimers([
      timer({
        id: "schedule-1",
        note: "write the daily report",
        dueAt: Date.now() + 3_600_000,
        recurrence: { type: "daily", at: "09:00", timeZone: "Asia/Shanghai" },
      }),
    ]);

    return call(tools(timers)["timer-list"], {}).then((result) => {
      expect(result.output).toContain("daily 09:00 Asia/Shanghai");
      expect(result.output).toContain("write the daily report");
    });
  });
});
