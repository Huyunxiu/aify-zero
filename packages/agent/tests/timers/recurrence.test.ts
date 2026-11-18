import { describe, expect, test } from "vitest";

import {
  nextOccurrence,
  renderRecurrence,
  resolveRecurrence,
} from "../../src/timers/recurrence.js";
import type { RecurrenceRule } from "../../src/timers/recurrence.js";
import { hostTimeZone, isTimeZone } from "../../src/utils/time-zone.js";

/** 用 ISO 时刻写期望值，读的人不必去认毫秒数。 */
const instant = (iso: string): number => Date.parse(iso);

const SHANGHAI = "Asia/Shanghai";

const daily = (at = "09:00", timeZone = SHANGHAI): RecurrenceRule => ({
  type: "daily",
  at,
  timeZone,
});

describe(nextOccurrence, () => {
  test("picks today when the clock time is still ahead", () => {
    // 上海 08:30 时找「每天九点」：就是今天九点。
    const next = nextOccurrence(daily(), {
      from: instant("2026-11-17T00:30:00Z"),
      after: instant("2026-11-17T00:30:00Z"),
    });

    expect(next).toBe(instant("2026-11-17T09:00:00+08:00"));
  });

  test("is strict, so the current occurrence does not count", () => {
    const nine = instant("2026-11-17T09:00:00+08:00");

    expect(nextOccurrence(daily(), { from: nine, after: nine })).toBe(
      instant("2026-11-18T09:00:00+08:00")
    );
  });

  test("moves to tomorrow when the clock time has passed", () => {
    const next = nextOccurrence(daily(), {
      from: instant("2026-11-17T09:00:00+08:00"),
      after: instant("2026-11-17T10:00:00+08:00"),
    });

    expect(next).toBe(instant("2026-11-18T09:00:00+08:00"));
  });

  test("follows the local calendar across a spring-forward gap", () => {
    // 2026-03-08 纽约没有 02:30，顺延到 03:30（-04:00 = 07:30Z）。
    const next = nextOccurrence(daily("02:30", "America/New_York"), {
      from: instant("2026-03-07T17:00:00Z"),
      after: instant("2026-03-07T17:00:00Z"),
    });

    expect(next).toBe(instant("2026-03-08T07:30:00Z"));
  });

  test("takes the first of two repeated local times", () => {
    // 2026-11-01 纽约 01:30 出现两次，取第一次（-04:00 = 05:30Z）。
    const next = nextOccurrence(daily("01:30", "America/New_York"), {
      from: instant("2026-11-01T04:00:00Z"),
      after: instant("2026-11-01T04:00:00Z"),
    });

    expect(next).toBe(instant("2026-11-01T05:30:00Z"));
  });

  test("weekly lands on the next listed weekday", () => {
    // 2026-11-17 是周二，规则只要周一。
    const next = nextOccurrence(
      {
        type: "weekly",
        at: "09:00",
        weekdays: [1],
        timeZone: SHANGHAI,
      },
      {
        from: instant("2026-11-17T00:00:00Z"),
        after: instant("2026-11-17T00:00:00Z"),
      }
    );

    expect(next).toBe(instant("2026-11-23T09:00:00+08:00"));
  });

  test("weekly with weekdays skips the weekend", () => {
    // 2026-11-20 是周五 18:00，下一个工作日是周一。
    const next = nextOccurrence(
      {
        type: "weekly",
        at: "09:00",
        weekdays: [1, 2, 3, 4, 5],
        timeZone: SHANGHAI,
      },
      {
        from: instant("2026-11-20T10:00:00Z"),
        after: instant("2026-11-20T10:00:00Z"),
      }
    );

    expect(next).toBe(instant("2026-11-23T09:00:00+08:00"));
  });

  test("interval starts one step after the first occurrence", () => {
    expect(
      nextOccurrence(
        { type: "interval", everySeconds: 600 },
        { from: 1000, after: 1000 }
      )
    ).toBe(1000 + 600_000);
  });

  test("interval keeps its phase after several missed firings", () => {
    const step = 600_000;
    const from = 1000;

    expect(
      nextOccurrence(
        { type: "interval", everySeconds: 600 },
        { from, after: from + 3 * step }
      )
    ).toBe(from + 4 * step);

    // 迟到半个步长时也不推后相位。
    expect(
      nextOccurrence(
        { type: "interval", everySeconds: 600 },
        { from, after: from + 3 * step + step / 2 }
      )
    ).toBe(from + 4 * step);
  });
});

describe(resolveRecurrence, () => {
  test("fills the session time zone when the model omits one", () => {
    expect(
      resolveRecurrence({ type: "daily", at: "09:00" }, SHANGHAI)
    ).toStrictEqual({ type: "daily", at: "09:00", timeZone: SHANGHAI });
  });

  test("keeps an explicit time zone", () => {
    expect(
      resolveRecurrence(
        { type: "daily", at: "09:00", timeZone: "Europe/Berlin" },
        SHANGHAI
      )
    ).toMatchObject({ timeZone: "Europe/Berlin" });
  });

  test("sorts and dedupes the weekdays", () => {
    expect(
      resolveRecurrence(
        { type: "weekly", at: "09:00", weekdays: [5, 1, 5] },
        SHANGHAI
      )
    ).toMatchObject({ weekdays: [1, 5] });
  });

  test("interval carries no time zone", () => {
    expect(
      resolveRecurrence({ type: "interval", everySeconds: 600 }, SHANGHAI)
    ).toStrictEqual({ type: "interval", everySeconds: 600 });
  });
});

describe(renderRecurrence, () => {
  test("names the clock time and the time zone", () => {
    expect(renderRecurrence(daily())).toBe("daily 09:00 Asia/Shanghai");
  });

  test("calls the working week what the user calls it", () => {
    expect(
      renderRecurrence({
        type: "weekly",
        at: "09:00",
        weekdays: [1, 2, 3, 4, 5],
        timeZone: SHANGHAI,
      })
    ).toBe("every weekday 09:00 Asia/Shanghai");
  });

  test("names the weekend", () => {
    expect(
      renderRecurrence({
        type: "weekly",
        at: "10:00",
        weekdays: [6, 7],
        timeZone: SHANGHAI,
      })
    ).toBe("every weekend 10:00 Asia/Shanghai");
  });

  test("names a single day and a list of days", () => {
    expect(
      renderRecurrence({
        type: "weekly",
        at: "09:00",
        weekdays: [3],
        timeZone: SHANGHAI,
      })
    ).toBe("every Wednesday 09:00 Asia/Shanghai");

    expect(
      renderRecurrence({
        type: "weekly",
        at: "09:00",
        weekdays: [1, 3],
        timeZone: SHANGHAI,
      })
    ).toBe("every Monday, Wednesday 09:00 Asia/Shanghai");
  });

  test("writes an interval in hours or minutes", () => {
    expect(renderRecurrence({ type: "interval", everySeconds: 7200 })).toBe(
      "every 2 hours"
    );
    expect(renderRecurrence({ type: "interval", everySeconds: 3600 })).toBe(
      "every hour"
    );
    expect(renderRecurrence({ type: "interval", everySeconds: 5400 })).toBe(
      "every 90 minutes"
    );
  });
});

describe(isTimeZone, () => {
  test("accepts a known zone and refuses an unknown one", () => {
    expect(isTimeZone(SHANGHAI)).toBeTruthy();
    expect(isTimeZone("Mars/Olympus")).toBeFalsy();
  });
});

describe(hostTimeZone, () => {
  test("returns a zone the formatter accepts", () => {
    expect(isTimeZone(hostTimeZone())).toBeTruthy();
  });
});
