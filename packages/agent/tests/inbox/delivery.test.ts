import { describe, expect, test } from "vitest";

import { resolveDeliverAt } from "../../src/inbox/delivery";

describe(resolveDeliverAt, () => {
  test("sends steering to the next step while a turn is running", () => {
    expect(
      resolveDeliverAt({
        mode: "steering",
        running: true,
        streamKind: "turn",
      })
    ).toBe("step-boundary");
  });

  test("sends steering to the next turn during a manual compaction", () => {
    expect(
      resolveDeliverAt({
        mode: "steering",
        running: true,
        streamKind: "compaction",
      })
    ).toBe("run-boundary");
  });

  test("sends steering to the next turn while idle", () => {
    expect(
      resolveDeliverAt({
        mode: "steering",
        running: false,
        streamKind: undefined,
      })
    ).toBe("run-boundary");
  });

  test("sends a follow-up to the next turn even while a turn is running", () => {
    expect(
      resolveDeliverAt({
        mode: "followup",
        running: true,
        streamKind: "turn",
      })
    ).toBe("run-boundary");
  });
});
