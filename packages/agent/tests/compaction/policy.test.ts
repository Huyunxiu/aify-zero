import { describe, expect, test } from "vitest";

import { resolvePolicy, shouldCompact } from "../../src/compaction/policy.js";

describe(resolvePolicy, () => {
  test("derives the threshold from the window and the reserve", () => {
    const policy = resolvePolicy({ contextWindow: 100_000 });
    expect(policy.thresholdTokens).toBe(80_000);
    expect(policy.auto).toBeTruthy();
    expect(policy.disabledReason).toBeUndefined();
  });

  test("keeps the reserve out of the window when it is the tighter bound", () => {
    const policy = resolvePolicy({
      contextWindow: 100_000,
      overrides: { reserveTokens: 30_000 },
    });
    expect(policy.thresholdTokens).toBe(70_000);
  });

  test("clamps the retained tail below the threshold", () => {
    const policy = resolvePolicy({
      contextWindow: 100_000,
      overrides: { keepRecentTokens: 90_000 },
    });
    expect(policy.keepRecentTokens).toBe(40_000);
  });

  test("disables automatic compaction without a window", () => {
    const policy = resolvePolicy();
    expect(policy.thresholdTokens).toBeUndefined();
    expect(policy.disabledReason).toContain("context window");
    expect(shouldCompact(1_000_000, policy)).toBeFalsy();
  });

  test("disables automatic compaction when the reserve eats the window", () => {
    const policy = resolvePolicy({
      contextWindow: 8000,
      overrides: { reserveTokens: 8000 },
    });
    expect(policy.thresholdTokens).toBeUndefined();
    expect(policy.disabledReason).toContain("no room");
  });

  test("respects the auto switch", () => {
    const policy = resolvePolicy({
      contextWindow: 100_000,
      overrides: { auto: false },
    });
    expect(policy.thresholdTokens).toBeUndefined();
    expect(policy.disabledReason).toContain("disabled");
  });
});
