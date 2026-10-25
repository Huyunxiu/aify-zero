import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";

import { createSummarizationPrompt } from "../../src/compaction/prompt.js";

const toolMessage = (value: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "grep",
      output: { type: "text", value },
    },
  ],
});

describe(createSummarizationPrompt, () => {
  test("caps a huge tool result instead of replaying it", () => {
    const prompt = createSummarizationPrompt({
      messages: [toolMessage("x".repeat(20_000))],
    });
    expect(prompt.prompt.length).toBeLessThan(10_000);
    expect(prompt.prompt).toContain("Tool result");
  });

  test("includes the previous checkpoint and the section skeleton", () => {
    const prompt = createSummarizationPrompt({
      messages: [{ role: "user", content: "hello" }],
      previousSummary: "older summary",
    });
    expect(prompt.prompt).toContain("older summary");
    expect(prompt.prompt).toContain("## Goal");
    expect(prompt.prompt).toContain("## Next Steps");
    expect(prompt.system).toContain("Do NOT continue the conversation");
  });

  test("drops the oldest messages to fit its own budget", () => {
    const messages: ModelMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: "user",
      content: `message-${index}-${"x".repeat(4000)}`,
    }));
    const prompt = createSummarizationPrompt({
      messages,
      maxPromptTokens: 3000,
    });
    expect(prompt.prompt).not.toContain("message-0-");
    expect(prompt.prompt).toContain("message-19-");
  });
});
