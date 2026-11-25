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

  test("prices a tool result by its parts, not by inline bytes", () => {
    const base64 = "A".repeat(40_000);
    const message = {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "call-1",
          toolName: "read-file",
          output: {
            type: "content" as const,
            value: [
              { type: "text" as const, text: "<path>a.png</path>" },
              {
                type: "file" as const,
                data: { type: "data" as const, data: base64 },
                mediaType: "image/png",
              },
            ],
          },
        },
      ],
    };

    const tokens = estimateMessageTokens(message);

    // An image costs a fixed amount on the provider side; counting the encoded
    // bytes would price one screenshot at tens of thousands of tokens.
    expect(tokens).toBeGreaterThan(1000);
    expect(tokens).toBeLessThan(2000);
  });
});
