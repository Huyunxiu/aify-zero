import { describe, expect, test } from "vitest";

import { waitFor } from "../../src/utils/wait-for.js";

describe(waitFor, () => {
  test("resolves when the delay is over", async () => {
    const startedAt = Date.now();

    await waitFor(10);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5);
  });

  test("resolves at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();

    await waitFor(5000, controller.signal);

    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  test("resolves when the signal aborts while waiting", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 10);

    await waitFor(5000, controller.signal);

    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
