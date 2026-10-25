import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";

import {
  PRUNE_MARKER,
  pruneOlderToolResults,
} from "../../src/compaction/prune.js";

const toolMessage = (id: string, value: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "grep",
      output: { type: "text", value },
    },
  ],
});

const options = {
  keepRecentTokens: 0,
  thresholdChars: 100,
  headChars: 40,
  tailChars: 20,
};

describe(pruneOlderToolResults, () => {
  test("caps an oversized result outside the protected tail", () => {
    const messages = [
      toolMessage("old", "x".repeat(500)),
      { role: "user" as const, content: "recent" },
    ];

    const pruned = pruneOlderToolResults(messages, options);
    const [first] = pruned;
    const [part] = (first as Extract<ModelMessage, { role: "tool" }>).content;
    const output = part as {
      output?: { type?: string; value?: string };
    };
    expect(output.output?.type).toBe("text");
    expect(output.output?.value ?? "").toContain(PRUNE_MARKER);
    expect(output.output?.value?.length ?? 0).toBeLessThan(500);
  });

  test("leaves the newest message alone even with a zero budget", () => {
    const messages = [toolMessage("newest", "x".repeat(500))];
    expect(pruneOlderToolResults(messages, options)).toBe(messages);
  });

  test("is idempotent", () => {
    const messages = [
      toolMessage("old", "x".repeat(500)),
      { role: "user" as const, content: "recent" },
    ];
    const once = pruneOlderToolResults(messages, options);
    expect(pruneOlderToolResults(once, options)).toBe(once);
  });

  test("protects everything inside the retention budget", () => {
    const messages = [
      toolMessage("old", "x".repeat(500)),
      { role: "user" as const, content: "recent" },
    ];
    expect(
      pruneOlderToolResults(messages, { ...options, keepRecentTokens: 100_000 })
    ).toBe(messages);
  });
});
