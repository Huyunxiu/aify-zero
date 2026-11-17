import { describe, expect, test } from "vitest";

import {
  composeTimerNotice,
  composeTimerTurn,
  formatAge,
} from "../../src/timers/notice.js";
import type { Timer } from "../../src/timers/types.js";

const timer = (overrides: Partial<Timer> = {}): Timer => ({
  id: "timer-1",
  sessionId: "session-1",
  toolCallId: "call-1",
  note: "check the deploy",
  dueAt: 600_000,
  payload: { model: { providerId: "p", modelId: "m" } },
  createdAt: 0,
  ...overrides,
});

describe(formatAge, () => {
  test("says less than a minute under a minute", () => {
    expect(formatAge(0)).toBe("less than a minute");
    expect(formatAge(59_999)).toBe("less than a minute");
  });

  test("counts whole minutes and hours", () => {
    expect(formatAge(60_000)).toBe("1 minute");
    expect(formatAge(12 * 60_000)).toBe("12 minutes");
    expect(formatAge(60 * 60_000)).toBe("1 hour");
    expect(formatAge(5 * 60 * 60_000)).toBe("5 hours");
  });

  test("switches to days after a full day", () => {
    expect(formatAge(24 * 60 * 60_000 - 1)).toBe("23 hours");
    expect(formatAge(24 * 60 * 60_000)).toBe("1 day");
    expect(formatAge(3 * 24 * 60 * 60_000)).toBe("3 days");
  });

  test("clamps a negative elapsed time", () => {
    expect(formatAge(-5000)).toBe("less than a minute");
  });
});

describe(composeTimerNotice, () => {
  test("carries the id, the age and the note", () => {
    const { text } = composeTimerNotice({
      timer: timer(),
      firedAt: 12 * 60_000,
    });

    expect(text).toContain("timer timer-1 fired");
    expect(text).toContain("You set it 12 minutes ago");
    expect(text).toContain("check the deploy");
  });

  test("does not leave a double period when the note ends with one", () => {
    const { text } = composeTimerNotice({
      timer: timer({ note: "check the deploy." }),
      firedAt: 60_000,
    });

    expect(text).not.toContain("..");
  });
});

describe(composeTimerTurn, () => {
  test("is a done user turn whose step carries the timer source", () => {
    const firedAt = 12 * 60_000;
    const turn = composeTimerTurn({ timer: timer(), firedAt });

    expect(turn).toMatchObject({
      type: "user",
      status: "done",
      createdAt: firedAt,
    });

    const [step] = turn.content;
    expect(step).toMatchObject({ source: "timer", status: "done" });
    expect(step?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("check the deploy"),
    });
  });
});
