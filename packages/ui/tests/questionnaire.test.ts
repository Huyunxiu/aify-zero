import type { AgentToolSet } from "@workspace/agent";
import type { AgentTurn } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import { findPendingQuestionnaire } from "../src/elements/questionnaire";

const questionnaire = (fields: Record<string, unknown> = {}) => ({
  approval: { createdAt: 1, id: "approval-1", isAutomatic: false },
  input: { questions: [{ id: "q1", prompt: "Pick one" }] },
  rawInput: "",
  state: "approval-requested",
  toolCallId: "call-1",
  type: "tool-questionnaire",
  ...fields,
});

const assistantTurn = (content: unknown[]): AgentTurn<AgentToolSet> =>
  ({
    content: [
      {
        content,
        createdAt: 1,
        id: "step-1",
        model: "test-model",
        status: "wait_review",
        type: "assistant",
      },
    ],
    createdAt: 1,
    id: "turn-1",
    status: "wait_review",
    type: "assistant",
  }) as AgentTurn<AgentToolSet>;

describe(findPendingQuestionnaire, () => {
  test("should find a questionnaire the turn is held on", () => {
    const part = questionnaire();

    expect(findPendingQuestionnaire([assistantTurn([part])])).toBe(part);
  });

  test("should find the earliest pending questionnaire in the held turn", () => {
    const first = questionnaire({ toolCallId: "call-1" });
    const second = questionnaire({ toolCallId: "call-2" });

    expect(findPendingQuestionnaire([assistantTurn([first, second])])).toBe(
      first
    );
  });

  test("should ignore a questionnaire that has been answered", () => {
    const part = questionnaire({
      approval: {
        approved: true,
        createdAt: 1,
        id: "approval-1",
        isAutomatic: false,
      },
      state: "approval-responded",
    });

    expect(findPendingQuestionnaire([assistantTurn([part])])).toBeUndefined();
  });

  test("should ignore an automatic hold", () => {
    const part = questionnaire({
      approval: { createdAt: 1, id: "approval-1", isAutomatic: true },
    });

    expect(findPendingQuestionnaire([assistantTurn([part])])).toBeUndefined();
  });

  test("should ignore a questionnaire with no questions", () => {
    const part = questionnaire({ input: { questions: [] } });

    expect(findPendingQuestionnaire([assistantTurn([part])])).toBeUndefined();
  });

  test("should ignore a questionnaire on an earlier assistant turn", () => {
    const part = questionnaire();

    expect(
      findPendingQuestionnaire([assistantTurn([part]), assistantTurn([])])
    ).toBeUndefined();
  });
});
