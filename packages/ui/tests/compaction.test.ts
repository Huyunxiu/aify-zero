import type {
  AgentCompactionPart,
  AgentCompactionStep,
} from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { formatTokens } from "../src/elements/compaction-message";
import {
  getPartDurationMs,
  getPartStatus,
  getPartSummary,
} from "../src/elements/tool-step";

const part: AgentCompactionPart = {
  type: "compaction",
  id: "compaction-1",
  state: "done",
  createdAt: 1000,
  completedAt: 3400,
  record: {
    version: 1,
    id: "compaction-1",
    trigger: "pressure",
    summary: "summary",
    tokensBefore: 12_000,
    tokensAfter: 1000,
    shadowedTokens: 11_000,
    shadowedTurns: 2,
    shadowedSteps: 4,
    model: "test-model",
    createdAt: 3400,
  },
};

const step: AgentCompactionStep = {
  id: "step-1",
  type: "compaction",
  createdAt: 1000,
  completedAt: 3400,
  status: "done",
  model: "test-model",
  content: [part],
};

describe("compaction rendering helpers", () => {
  test("a committed compaction part is complete", () => {
    expect(getPartStatus(part)).toBe("complete");
    expect(getPartSummary(part)).toBe("context compacted");
  });

  test("a part opened by compaction.start is still running", () => {
    const streaming: AgentCompactionPart = {
      type: "compaction",
      id: "compaction-1",
      state: "streaming",
      createdAt: 1000,
    };
    expect(getPartStatus(streaming)).toBe("running");
    expect(getPartSummary(streaming)).toBeUndefined();
    expect(getPartDurationMs(streaming, step)).toBeUndefined();
  });

  test("a compacted part is timed by its own start and end", () => {
    expect(getPartDurationMs(part, step)).toBe(2400);
  });

  test("a manual marker has no span to show", () => {
    const manual: AgentCompactionPart = {
      type: "compaction",
      id: "compaction-2",
      state: "done",
      createdAt: 5000,
      record: { ...part.record!, trigger: "manual" },
    };
    expect(getPartDurationMs(manual, step)).toBeUndefined();
  });

  test("token counts read compactly", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_345)).toBe("12.3k");
  });
});
