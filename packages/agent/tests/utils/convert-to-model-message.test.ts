import type { AgentTurn } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import type { AgentToolSet } from "../../src/types.js";
import { convertAgentTurnToModalMessage } from "../../src/utils/convert-to-model-message.js";
import {
  assistantStep,
  assistantTurn,
  steeringStep,
} from "../compaction/fixtures.js";

/**
 * An assistant turn holding one `task` call, in the state a case is about.
 *
 * Built through the real turn type rather than restated: the converter is what
 * decides how these are read, and a test that declared its own shape would only
 * agree with itself.
 */
const turnWithCall = (
  fields: Record<string, unknown>
): AgentTurn<AgentToolSet>[] =>
  [
    {
      id: "turn-1",
      type: "assistant",
      createdAt: 1000,
      status: "done",
      content: [
        {
          id: "step-1",
          type: "assistant",
          model: "test-model",
          createdAt: 1000,
          status: "done",
          content: [
            {
              type: "tool-task",
              toolCallId: "call-1",
              rawInput: "{}",
              input: {
                subagent_type: "explore",
                description: "look",
                prompt: "",
              },
              state: "output-available",
              output: { code: "ok", output: "", metadata: { status: "done" } },
              ...fields,
            },
          ],
        },
      ],
    },
  ] as AgentTurn<AgentToolSet>[];

describe(convertAgentTurnToModalMessage, () => {
  test("drops a call that has only reported part-way through", async () => {
    // The report is not the call's outcome, and a tool call handed to the model
    // without a result is a broken turn — so the call goes with it. The turn it
    // sits in is still running; the model reads it once it has finished.
    await expect(
      convertAgentTurnToModalMessage(
        turnWithCall({ preliminary: true, output: { code: "ok", output: "" } })
      )
    ).resolves.toStrictEqual([]);
  });

  test("gives the model the same call once it has finished", async () => {
    const messages = await convertAgentTurnToModalMessage(turnWithCall({}));

    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "task" }],
    });
    expect(messages[1]).toMatchObject({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call-1", toolName: "task" },
      ],
    });
  });

  test("gives the model a call that failed after reporting", async () => {
    // The flag is read off the state, not on its own: a call that ended in
    // error is finished, and what it has to say is the failure. Its report
    // leaves the flag behind, and reading that alone would hide the failure.
    const messages = await convertAgentTurnToModalMessage(
      turnWithCall({
        state: "output-error",
        errorText: "boom",
        preliminary: true,
      })
    );

    expect(messages[1]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "task",
          output: { type: "error-text", value: "boom" },
        },
      ],
    });
  });

  test("puts a steering step in the history as a user message at its position", async () => {
    const messages = await convertAgentTurnToModalMessage([
      assistantTurn("a1", [
        assistantStep("s1", { text: "before" }),
        steeringStep("steer-1", "try the other path"),
        assistantStep("s2", { text: "after" }),
      ]),
    ]);

    expect(messages.map((message) => message.role)).toStrictEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "try the other path" }],
    });
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "before" }],
    });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "after" }],
    });
  });
});
