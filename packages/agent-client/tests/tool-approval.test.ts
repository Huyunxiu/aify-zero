import type { ToolSet } from "ai";
import { describe, expect, test } from "vitest";

import { addToolApprovalResponse } from "../src/tool-approval";
import type {
  AgentAssistantTurn,
  AgentStaticToolPart,
  AgentTurn,
  TextStreamToolApprovalResponseEvent,
} from "../src/types";

/**
 * A held turn: one assistant step with a call waiting on the user. The request
 * carries a descriptor and a reason so a case can check that answering keeps
 * them, rather than rebuilding the approval from the response alone.
 */
const heldTurns = (): AgentTurn[] =>
  [
    {
      id: "turn-1",
      type: "assistant",
      createdAt: 1,
      status: "wait_review",
      content: [
        {
          id: "step-1",
          type: "assistant",
          model: "test-model",
          createdAt: 1,
          status: "done",
          content: [
            {
              type: "tool-echo",
              toolCallId: "call-1",
              rawInput: "",
              state: "approval-requested",
              input: {},
              approval: {
                id: "ap-1",
                createdAt: 1,
                descriptor: { kind: "write" },
                requestReason: "needs review",
              },
            },
          ],
        },
      ],
    },
  ] as unknown as AgentTurn[];

const heldPart = (turns: AgentTurn[]): AgentStaticToolPart => {
  const turn = turns[0] as AgentAssistantTurn<ToolSet>;
  return turn.content[0]!.content[0] as AgentStaticToolPart;
};

const answer = (
  overrides: Partial<TextStreamToolApprovalResponseEvent> = {}
): TextStreamToolApprovalResponseEvent => ({
  type: "tool.approval-response",
  id: "call-1",
  approvalId: "ap-1",
  approved: true,
  turnId: "turn-1",
  stepId: "step-1",
  createdAt: 2,
  ...overrides,
});

describe(addToolApprovalResponse, () => {
  test("keeps the answer's data on the approval", () => {
    const turns = heldTurns();

    const changed = addToolApprovalResponse(turns, [
      answer({ data: { scope: "session" } }),
    ]);

    expect(changed).toStrictEqual([turns[0]]);

    const part = heldPart(turns);
    expect(part.state).toBe("approval-responded");
    expect(part.approval).toMatchObject({
      id: "ap-1",
      approved: true,
      approvedAt: 2,
      descriptor: { kind: "write" },
      requestReason: "needs review",
      data: { scope: "session" },
    });
  });

  test("leaves data off an answer that carries none", () => {
    const turns = heldTurns();

    addToolApprovalResponse(turns, [answer()]);

    const part = heldPart(turns);
    expect(part.state).toBe("approval-responded");
    expect(part.approval).not.toHaveProperty("data");
  });
});
