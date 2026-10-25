import { describe, expect, test } from "vitest";

import {
  compactionRecordOf,
  createCompactionStep,
  createCompactionTurn,
} from "../../src/compaction/marker.js";
import { record } from "./fixtures.js";

describe("compaction markers", () => {
  test("a step carries the record on its single part", () => {
    const value = record();
    const step = createCompactionStep(value);
    expect(step.type).toBe("compaction");
    expect(step.content).toHaveLength(1);
    expect(step.content[0]?.record).toBe(value);
    expect(compactionRecordOf(step)).toBe(value);
  });

  test("a turn holds exactly one marker step", () => {
    const value = record({ trigger: "manual" });
    const turn = createCompactionTurn(value);
    expect(turn.type).toBe("compaction");
    expect(turn.content).toHaveLength(1);
    expect(compactionRecordOf(turn.content[0]!)).toBe(value);
  });

  test("a non-compaction step has no record", () => {
    expect(
      compactionRecordOf({
        id: "s",
        type: "assistant",
        createdAt: 1,
        status: "done",
        model: "m",
        content: [],
      })
    ).toBeUndefined();
  });
});
