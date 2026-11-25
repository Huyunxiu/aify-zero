import type { AgentToolSet, AgentTurn } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { findSubagentTitle } from "../src/lib/subagent-call";

/**
 * A turn shaped the way the server writes one: a turn holds steps, a step holds
 * parts. Only the part is cast, so the nesting under test is the real one.
 */
const turnWithTask = (
  description: string,
  childSessionId: string
): AgentTurn<AgentToolSet> =>
  ({
    id: "turn-1",
    status: "done",
    type: "assistant",
    content: [
      {
        id: "step-1",
        type: "assistant",
        content: [
          {
            type: "tool-task",
            state: "output-available",
            input: { subagent_type: "explore", description },
            output: {
              code: "ok",
              output: "",
              metadata: { sessionId: childSessionId },
            },
          },
        ],
      },
    ],
  }) as unknown as AgentTurn<AgentToolSet>;

describe("subagent calls", () => {
  test("finds the description of the call that made the child", () => {
    const turns = [turnWithTask("Explore the parser", "child-1")];

    expect(findSubagentTitle(turns, "child-1")).toBe("Explore the parser");
  });

  test("a child no call in this record names has no title", () => {
    const turns = [turnWithTask("Explore the parser", "child-1")];

    expect(findSubagentTitle(turns, "child-2")).toBeUndefined();
    expect(findSubagentTitle([], "child-1")).toBeUndefined();
  });
});
