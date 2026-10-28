import { describe, expect, test } from "vitest";

import { resolveInboxPlacement } from "../src/routers/session.schema";

describe(resolveInboxPlacement, () => {
  test("sends steering to the next step while a turn is running", () => {
    expect(
      resolveInboxPlacement({
        mode: "steering",
        running: true,
        streamKind: "turn",
      })
    ).toBe("next-step");
  });

  test("sends steering to the next turn during a manual compaction", () => {
    expect(
      resolveInboxPlacement({
        mode: "steering",
        running: true,
        streamKind: "compaction",
      })
    ).toBe("next-turn");
  });

  test("sends steering to the next turn while idle", () => {
    expect(
      resolveInboxPlacement({
        mode: "steering",
        running: false,
        streamKind: undefined,
      })
    ).toBe("next-turn");
  });

  test("sends a follow-up to the next turn even while a turn is running", () => {
    expect(
      resolveInboxPlacement({
        mode: "followup",
        running: true,
        streamKind: "turn",
      })
    ).toBe("next-turn");
  });
});
