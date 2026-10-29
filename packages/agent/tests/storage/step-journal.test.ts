import type { AgentStreamEvent } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { journaledStepTarget } from "../../src/storage/step-journal.js";
import type { AgentToolSet } from "../../src/types.js";

const event = (value: Record<string, unknown>) =>
  value as unknown as AgentStreamEvent<AgentToolSet>;

describe(journaledStepTarget, () => {
  test("writes the step when it finishes", () => {
    expect(
      journaledStepTarget(
        event({ type: "step.finish", stepId: "step-1", turnId: "turn-1" })
      )
    ).toStrictEqual({ turnId: "turn-1", stepId: "step-1" });
  });

  test("writes the step when its metadata changes", () => {
    expect(
      journaledStepTarget(
        event({ type: "step.metadata", stepId: "step-1", turnId: "turn-1" })
      )
    ).toStrictEqual({ turnId: "turn-1", stepId: "step-1" });
  });

  test("writes the step when a held call is denied", () => {
    expect(
      journaledStepTarget(
        event({
          type: "tool.output-denied",
          stepId: "step-1",
          turnId: "turn-1",
        })
      )
    ).toStrictEqual({ turnId: "turn-1", stepId: "step-1" });
  });

  test("ignores incremental events", () => {
    expect(
      journaledStepTarget(
        event({ type: "text.delta", stepId: "step-1", turnId: "turn-1" })
      )
    ).toBeUndefined();
    expect(
      journaledStepTarget(event({ type: "turn.start", turnId: "turn-1" }))
    ).toBeUndefined();
  });
});
