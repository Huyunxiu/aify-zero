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

  test("renders a content result as a stub that names the path to re-read", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read-file",
            output: {
              type: "content",
              value: [
                { type: "text", text: "short" },
                {
                  type: "file",
                  data: { type: "data", data: "A".repeat(400) },
                  mediaType: "image/png",
                  filename: "/tmp/a.png",
                },
              ],
            },
          },
        ],
      },
      { role: "user", content: "recent" },
    ];

    // A head wide enough to keep the whole stub: this test is about the sentence
    // the pruner writes, not about where it cuts.
    const pruned = pruneOlderToolResults(messages, {
      ...options,
      thresholdChars: 40,
      headChars: 200,
    });
    const [part] = (pruned[0] as Extract<ModelMessage, { role: "tool" }>)
      .content;
    const output = part as { output?: { type?: string; value?: string } };

    expect(output.output?.type).toBe("text");
    expect(output.output?.value ?? "").toContain("[Attached file /tmp/a.png");
    expect(output.output?.value ?? "").toContain(
      "read it again with read-file"
    );
  });
});
