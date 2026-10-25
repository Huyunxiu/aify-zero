import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";

import { resolvePolicy } from "../../src/compaction/policy.js";
import {
  findPreTurnPlacement,
  planManualCompaction,
} from "../../src/compaction/select.js";
import type { ProjectedHistory } from "../../src/compaction/types.js";
import {
  asTurns,
  assistantTurn,
  compactionTurn,
  record,
  userTurn,
} from "./fixtures.js";

const textMessage = (
  role: "user" | "assistant",
  length: number
): ModelMessage => ({
  role,
  content: "x".repeat(length),
});

const projected = (input: {
  messages: ModelMessage[];
  turnIds: string[];
  lastUserId?: string;
  checkpoint?: ProjectedHistory["checkpoint"];
}): ProjectedHistory => {
  const turnAnchors = input.turnIds.map((turnId, index) => ({
    turnId,
    messageIndex: index,
  }));
  return {
    messages: input.messages,
    turnAnchors,
    stepAnchors: [],
    lastUserTurn:
      input.lastUserId === undefined
        ? undefined
        : turnAnchors.find((anchor) => anchor.turnId === input.lastUserId),
    checkpoint: input.checkpoint,
  };
};

describe(findPreTurnPlacement, () => {
  test("places the marker at the end of the previous assistant turn", () => {
    const placement = findPreTurnPlacement(
      asTurns(
        userTurn("u1", "one"),
        assistantTurn("a1", []),
        userTurn("u2", "two")
      )
    );
    expect(placement).toStrictEqual({ turnId: "a1", stepIndex: 0 });
  });

  test("skips a head that is a compaction turn", () => {
    expect(
      findPreTurnPlacement(
        asTurns(userTurn("u1", "one"), compactionTurn(record()))
      )
    ).toBeUndefined();
  });

  test("skips a single-turn history", () => {
    expect(
      findPreTurnPlacement(asTurns(userTurn("u1", "one")))
    ).toBeUndefined();
  });
});

describe(planManualCompaction, () => {
  const turns = asTurns(
    userTurn("u1", "one"),
    assistantTurn("a1", []),
    userTurn("u2", "two"),
    assistantTurn("a2", [])
  );
  const messages = [
    textMessage("user", 10_000),
    textMessage("assistant", 10_000),
    textMessage("user", 10_000),
    textMessage("assistant", 10_000),
  ];
  const history = projected({
    messages,
    turnIds: ["u1", "a1", "u2", "a2"],
    lastUserId: "u2",
  });

  test("keeps the newest user turn and records it as the retained cut", () => {
    const plan = planManualCompaction(
      turns,
      history,
      resolvePolicy({
        contextWindow: 100_000,
        overrides: { keepRecentTokens: 100 },
      })
    );

    expect(plan?.mode).toBe("recent");
    expect(plan?.retainedFromTurnId).toBe("u2");
    expect(plan?.parentTurnId).toBe("a2");
    expect(plan?.region).toStrictEqual({ start: 0, end: 2 });
  });

  test("falls back to full when the retained tail cannot fit", () => {
    const bigMessages = [
      textMessage("user", 10_000),
      textMessage("assistant", 10_000),
      textMessage("user", 10_000),
      textMessage("assistant", 10_000),
    ];
    const plan = planManualCompaction(
      turns,
      projected({
        messages: bigMessages,
        turnIds: ["u1", "a1", "u2", "a2"],
        lastUserId: "u2",
      }),
      resolvePolicy({ contextWindow: 9000, overrides: { reserveTokens: 0 } })
    );

    expect(plan?.mode).toBe("full");
    expect(plan?.retainedFromTurnId).toBeUndefined();
    expect(plan?.parentTurnId).toBe("a2");
  });

  test("does nothing when there is not enough history", () => {
    const plan = planManualCompaction(
      asTurns(userTurn("u1", "one"), assistantTurn("a1", [])),
      projected({
        messages: [textMessage("user", 40), textMessage("assistant", 40)],
        turnIds: ["u1", "a1"],
        lastUserId: "u1",
      }),
      resolvePolicy({ contextWindow: 100_000 })
    );
    expect(plan).toBeUndefined();
  });
});
