import { tool } from "ai";
import type * as AiModule from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

import {
  script,
  stepResult,
  streamTextMock,
} from "../helpers/stream-harness.js";
import { FakeStore, makeAgent, runTurn } from "../helpers/turn-agent.js";

// `streamText` is the only model call the loop makes; the scripted steps below
// keep this test on the turn/step machinery.
vi.mock(import("ai"), async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    streamText: vi.fn<
      typeof AiModule.streamText
    >() as unknown as typeof actual.streamText,
  };
});

const echoTool = () =>
  tool({
    description: "Echoes a value.",
    inputSchema: z.object({ value: z.string() }),
    execute: ({ value }) => ({ value }),
    toModelOutput: () => ({ type: "text", value: "ok" }),
  });

describe("turn stream characterization", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
  });

  test("a text-only step ends the turn and is journaled once", async () => {
    const store = new FakeStore();
    const { agent } = makeAgent(store);

    script(stepResult({ text: "Hello." }));

    const { events, finished } = await runTurn(agent, "Hi.");

    expect(events).toStrictEqual([
      "turn.start",
      "step.start",
      "step.finish",
      "turn.finish",
    ]);
    expect({
      begun: store.begun.length,
      saved: store.savedSteps.map((step) => step.status),
      // 终态 header 一次，收尾回写一次。
      updated: store.updated.length,
      finished,
    }).toStrictEqual({
      begun: 1,
      saved: ["done"],
      updated: 2,
      finished: ["done"],
    });
    expect(store.updated[1]?.id).toBe((store.begun[0] as { id: string }).id);
  });

  test("a resolved tool call runs another step before the turn ends", async () => {
    const store = new FakeStore();
    const { agent } = makeAgent(store);
    agent.registerTool("echo", echoTool());

    script(
      stepResult({
        toolCalls: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "echo",
            input: { value: "hi" },
            providerExecuted: false,
          },
        ],
        responseMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "echo",
                input: { value: "hi" },
              },
            ],
          },
        ],
      }),
      stepResult({ text: "Done." })
    );

    const { events, finished } = await runTurn(agent, "Echo it.");

    expect(events).toStrictEqual([
      "turn.start",
      "step.start",
      "tool.result",
      "step.finish",
      "step.start",
      "step.finish",
      "turn.finish",
    ]);
    expect(store.savedSteps).toHaveLength(2);
    // 终态 header 一次，收尾回写一次。
    expect(store.updated).toHaveLength(2);
    expect(finished).toStrictEqual(["done"]);
  });
  test("declares only the tools that are not deferred", async () => {
    const { agent } = makeAgent(new FakeStore());
    agent.registerTool("host-tool", echoTool());
    agent.registerTool("linear__list_issues", echoTool(), "deferred");

    script(stepResult({ text: "Done." }));

    await runTurn(agent, "Say hi.");

    // 这一步交给 SDK 的工具集里没有 deferred 的那个，但它仍在工具集里。
    const call = streamTextMock.mock.calls[0]?.[0];
    expect(Object.keys(call?.tools ?? {})).toStrictEqual(["host-tool"]);
    expect(agent.tools.linear__list_issues).toBeDefined();
  });
});
