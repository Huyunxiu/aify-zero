/* oxlint-disable vitest/max-expects */
import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";

import {
  CompactionError,
  compactHistory,
} from "../../src/compaction/compact.js";
import { resolvePolicy } from "../../src/compaction/policy.js";
import type {
  ProjectedHistory,
  SummarizeFn,
} from "../../src/compaction/types.js";

const messages: ModelMessage[] = Array.from({ length: 10 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: "x".repeat(4000),
}));

const history: ProjectedHistory = {
  messages,
  turnAnchors: [],
  stepAnchors: [],
};

const policy = resolvePolicy({ contextWindow: 100_000 });

const summarize =
  (text: string, finishReason = "stop"): SummarizeFn =>
  () =>
    Promise.resolve({ text, finishReason });

describe(compactHistory, () => {
  test("produces a checkpoint and a record", async () => {
    const result = await compactHistory({
      projected: history,
      policy,
      trigger: "manual",
      modelId: "test-model",
      summarize: summarize("A short summary."),
      region: { start: 0, end: 5 },
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("expected a compaction result");
    }
    expect(result).toMatchObject({
      checkpoint: { role: "user" },
      record: { model: "test-model", summary: "A short summary." },
    });
    expect(result.record.tokensBefore).toBeGreaterThan(0);
    expect(result.record.tokensAfter).toBeLessThan(result.record.tokensBefore);
    expect(JSON.stringify(result.checkpoint.content)).toContain(
      "<compacted-summary>"
    );
  });

  test("rejects an empty summary", async () => {
    await expect(
      compactHistory({
        projected: history,
        policy,
        trigger: "manual",
        modelId: "test-model",
        summarize: summarize("   "),
        region: { start: 0, end: 5 },
      })
    ).rejects.toBeInstanceOf(CompactionError);
  });

  test("rejects a summary truncated at the token cap", async () => {
    await expect(
      compactHistory({
        projected: history,
        policy,
        trigger: "manual",
        modelId: "test-model",
        summarize: summarize("partial", "length"),
        region: { start: 0, end: 5 },
      })
    ).rejects.toBeInstanceOf(CompactionError);
  });

  test("rejects a summary that is not smaller", async () => {
    await expect(
      compactHistory({
        projected: history,
        policy,
        trigger: "manual",
        modelId: "test-model",
        summarize: summarize("x".repeat(20_000)),
        region: { start: 0, end: 5 },
      })
    ).rejects.toBeInstanceOf(CompactionError);
  });

  test("honours an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      compactHistory({
        projected: history,
        policy,
        trigger: "manual",
        modelId: "test-model",
        summarize: summarize("summary"),
        region: { start: 0, end: 5 },
        signal: controller.signal,
      })
    ).rejects.toThrow(/abort/i);
  });

  test("returns null for an empty region", async () => {
    const result = await compactHistory({
      projected: history,
      policy,
      trigger: "manual",
      modelId: "test-model",
      summarize: summarize("summary"),
      region: { start: 3, end: 3 },
    });
    expect(result).toBeNull();
  });
});
