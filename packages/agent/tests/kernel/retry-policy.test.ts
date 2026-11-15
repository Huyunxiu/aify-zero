import { APICallError, StreamProviderError } from "ai";
import { describe, expect, test } from "vitest";

import {
  isRetryableError,
  delayForRetry,
  backoffDelayMs,
  retryReason,
  shouldRetry,
} from "../../src/kernel/retry-policy.js";

const apiCallError = (
  options: { isRetryable?: boolean; headers?: Record<string, string> } = {}
) =>
  new APICallError({
    message: "Too Many Requests",
    url: "https://example.test/v1/chat",
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: options.isRetryable ?? true,
    responseHeaders: options.headers,
  });

const streamProviderError = (isRetryable: boolean) =>
  new StreamProviderError({
    message: "provider failed after the stream started",
    statusCode: 503,
    isRetryable,
  });

describe(backoffDelayMs, () => {
  test("doubles the wait and then holds it at the ceiling", () => {
    expect([1, 2, 3, 4, 5].map(backoffDelayMs)).toStrictEqual([
      2000, 4000, 8000, 8000, 8000,
    ]);
  });
});

describe(isRetryableError, () => {
  test("reads the provider's own classification before the request", () => {
    expect(isRetryableError(apiCallError({ isRetryable: true }))).toBeTruthy();
    expect(isRetryableError(apiCallError({ isRetryable: false }))).toBeFalsy();
  });

  test("reads it after the stream started too", () => {
    expect(isRetryableError(streamProviderError(true))).toBeTruthy();
    expect(isRetryableError(streamProviderError(false))).toBeFalsy();
  });

  test("treats anything else as not retryable", () => {
    expect(isRetryableError(new Error("boom"))).toBeFalsy();
    expect(isRetryableError("boom")).toBeFalsy();
    expect(isRetryableError(null)).toBeFalsy();
  });
});

describe(shouldRetry, () => {
  test("retries a retryable error while the budget lasts", () => {
    expect(shouldRetry({ error: apiCallError(), retriesUsed: 0 })).toBeTruthy();
  });

  test("stops when the budget is spent", () => {
    expect(shouldRetry({ error: apiCallError(), retriesUsed: 5 })).toBeFalsy();
  });

  test("retries a recovered overflow even without a classification", () => {
    expect(
      shouldRetry({
        error: new Error("context window exceeded"),
        overflowRecovered: true,
        retriesUsed: 0,
      })
    ).toBeTruthy();
  });

  test("stops retrying a recovered overflow once the budget is spent", () => {
    expect(
      shouldRetry({
        error: new Error("context window exceeded"),
        overflowRecovered: true,
        retriesUsed: 5,
      })
    ).toBeFalsy();
  });

  test("does not retry an error the provider called final", () => {
    expect(
      shouldRetry({
        error: apiCallError({ isRetryable: false }),
        retriesUsed: 0,
      })
    ).toBeFalsy();
  });
});

describe(delayForRetry, () => {
  test("falls back to the backoff without headers", () => {
    expect(delayForRetry(2, apiCallError())).toBe(4000);
  });

  test("takes retry-after-ms as milliseconds", () => {
    const error = apiCallError({ headers: { "retry-after-ms": "500" } });
    expect(delayForRetry(1, error)).toBe(500);
  });

  test("takes retry-after as seconds", () => {
    const error = apiCallError({ headers: { "retry-after": "7" } });
    expect(delayForRetry(1, error)).toBe(7000);
  });

  test("takes an HTTP date as the time left until it", () => {
    const now = Date.parse("2026-11-15T00:00:00Z");
    const error = apiCallError({
      headers: { "retry-after": "Sun, 15 Nov 2026 00:00:08 GMT" },
    });
    expect(delayForRetry(1, error, now)).toBe(8000);
  });

  test("prefers retry-after-ms over retry-after", () => {
    const error = apiCallError({
      headers: { "retry-after-ms": "500", "retry-after": "30" },
    });
    expect(delayForRetry(1, error)).toBe(500);
  });

  test("falls back when the header asks for longer than the limit", () => {
    const error = apiCallError({ headers: { "retry-after": "120" } });
    expect(delayForRetry(1, error)).toBe(2000);
  });

  test("falls back on values it cannot read", () => {
    expect(
      delayForRetry(1, apiCallError({ headers: { "retry-after": "soon" } }))
    ).toBe(2000);
    expect(
      delayForRetry(1, apiCallError({ headers: { "retry-after-ms": "-5" } }))
    ).toBe(2000);
  });

  test("ignores headers on an error that carries none", () => {
    expect(delayForRetry(1, streamProviderError(true))).toBe(2000);
  });
});

describe(retryReason, () => {
  test("keeps the first line of the message", () => {
    expect(retryReason(new Error("429 Too Many Requests\nbody: ..."))).toBe(
      "429 Too Many Requests"
    );
  });

  test("truncates a long line", () => {
    const reason = retryReason(new Error("x".repeat(200)));
    expect(reason).toHaveLength(80);
    expect(reason.endsWith("…")).toBeTruthy();
  });

  test("says something when the error has no message", () => {
    expect(retryReason(null)).toBe("unknown error");
  });
});
