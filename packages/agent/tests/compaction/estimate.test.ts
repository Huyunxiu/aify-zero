import { describe, expect, test } from "vitest";

import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  estimateTokens,
} from "../../src/compaction/estimate.js";

describe("token estimates", () => {
  test("uses one ruler for text and JSON", () => {
    expect(estimateTextTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens({ value: "a".repeat(400) })).toBeGreaterThan(100);
  });

  test("counts an image at a fixed cost, not its URL length", () => {
    const message = {
      role: "user" as const,
      content: [
        {
          type: "file" as const,
          mediaType: "image/png",
          data: {
            type: "url" as const,
            url: new URL("https://example.com/a.png"),
          },
        },
      ],
    };
    expect(estimateMessageTokens(message)).toBeGreaterThan(1000);
  });

  test("sums messages", () => {
    const messages = [
      { role: "user" as const, content: "a".repeat(400) },
      { role: "assistant" as const, content: "b".repeat(400) },
    ];
    expect(estimateMessagesTokens(messages)).toBe(
      estimateMessageTokens(messages[0]!) + estimateMessageTokens(messages[1]!)
    );
  });
});
