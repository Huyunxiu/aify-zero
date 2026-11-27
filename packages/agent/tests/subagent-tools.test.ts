import { describe, expect, test } from "vitest";

import type { Subagents } from "../src/extensions/capabilities.js";
import { SUBAGENT_DEFINITIONS } from "../src/subagent/definitions.js";
import {
  SubagentLimitReachedError,
  SubagentNotFoundError,
} from "../src/subagent/factory.js";
import { createCreateSubagentTool } from "../src/tools/create-subagent.js";
import { createListAgentsTool } from "../src/tools/list-agents.js";
import { createSendMessageTool } from "../src/tools/send-message.js";
import { createStopAgentTool } from "../src/tools/stop-agent.js";

/**
 * The capability as the tools see it. Each test overrides only the answer it is
 * about, so a failing test names the one behaviour it was checking.
 */
const capability = (overrides: Partial<Subagents> = {}): Subagents => ({
  create: () => Promise.resolve({ name: "AGENT-1", sessionId: "child-1" }),
  list: () => Promise.resolve({ running: 0, limit: 8, subagents: [] }),
  deliver: () => Promise.resolve("started"),
  stop: () => Promise.resolve(true),
  ...overrides,
});

const createTool = (subagents: Subagents) =>
  createCreateSubagentTool({ subagents, definitions: SUBAGENT_DEFINITIONS });

/** What every one of these tools answers with. */
type Answer = {
  output?: string;
  code?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Run a tool the way the kernel does: it may answer directly or yield, and the
 * last value yielded is the call's result.
 */
const runTool = async (
  definition: object,
  input: Record<string, unknown>
): Promise<Answer> => {
  const { execute } = definition as {
    execute?: (input: unknown, options: unknown) => unknown;
  };
  let result: unknown = await execute?.(input, { toolCallId: "call-1" });

  if (
    result !== null &&
    typeof result === "object" &&
    Symbol.asyncIterator in result
  ) {
    for await (const item of result as AsyncIterable<unknown>) {
      result = item;
    }
  }

  return result as Answer;
};

describe("create-subagent", () => {
  test("answers with the name to reach later, and does not wait for the report", async () => {
    const result = await runTool(createTool(capability()), {
      subagent_type: "explore",
      description: "Find the router",
      prompt: "Find the router.",
    });

    expect(result).toStrictEqual({
      output: "started subagent AGENT-1 (explore)",
      code: "ok",
      metadata: { status: "running", name: "AGENT-1", sessionId: "child-1" },
    });
  });

  test("names the choices when the type is not one of them", async () => {
    const result = await runTool(createTool(capability()), {
      subagent_type: "reviewer",
      description: "Review",
      prompt: "Review it.",
    });

    expect(result.code).toBe("error");
    expect(result.output).toBe(
      'No subagent named "reviewer". Available: general, explore, plan.'
    );
  });

  test("passes a full session's refusal through as a sentence the model can act on", async () => {
    const result = await runTool(
      createTool(
        capability({
          create: () => Promise.reject(new SubagentLimitReachedError(2)),
        })
      ),
      { subagent_type: "general", description: "Do it", prompt: "Do it." }
    );

    expect(result.code).toBe("error");
    expect(result.output).toContain("subagent limit reached (2 running)");
  });
});

describe("list-agents", () => {
  test("says so plainly when the session holds none", async () => {
    const result = await runTool(
      createListAgentsTool({ subagents: capability() }),
      {}
    );

    expect(result.output).toBe("No subagents.");
  });

  test("puts the name first and the age of a run beside it", async () => {
    const result = await runTool(
      createListAgentsTool({
        subagents: capability({
          list: () =>
            Promise.resolve({
              running: 1,
              limit: 8,
              subagents: [
                {
                  name: "AGENT-1",
                  sessionId: "child-1",
                  subagentType: "explore",
                  status: "running",
                  runningMs: 12 * 60_000,
                },
                {
                  name: "AGENT-2",
                  sessionId: "child-2",
                  subagentType: "general",
                  status: "idle",
                },
              ],
            }),
        }),
      }),
      {}
    );

    expect(result.output).toBe(
      [
        "1 of 8 running.",
        "",
        "- AGENT-1 (explore) running for 12m",
        "- AGENT-2 (general) idle",
      ].join("\n")
    );
  });
});

describe("send-message", () => {
  test("says it started a turn when the subagent was idle", async () => {
    const result = await runTool(
      createSendMessageTool({
        subagents: capability({ deliver: () => Promise.resolve("started") }),
      }),
      { name: "AGENT-1", text: "Look again." }
    );

    expect(result).toStrictEqual({
      output: "delivered to AGENT-1; it started a turn",
      code: "ok",
      metadata: { name: "AGENT-1", delivery: "started" },
    });
  });

  test("says it queued when the subagent is still working", async () => {
    const result = await runTool(
      createSendMessageTool({
        subagents: capability({ deliver: () => Promise.resolve("queued") }),
      }),
      { name: "AGENT-1", text: "Also check the tests." }
    );

    expect(result.output).toBe(
      "queued for AGENT-1; it reads this after its current turn"
    );
    expect(result.metadata).toStrictEqual({
      name: "AGENT-1",
      delivery: "queued",
    });
  });

  test("refuses a name this session does not hold", async () => {
    const result = await runTool(
      createSendMessageTool({
        subagents: capability({
          deliver: () => Promise.reject(new SubagentNotFoundError("AGENT-9")),
        }),
      }),
      { name: "AGENT-9", text: "Hello." }
    );

    expect(result.code).toBe("error");
    expect(result.output).toBe('No subagent named "AGENT-9".');
  });
});

describe("stop-agent", () => {
  test("reports a run it stopped", async () => {
    const result = await runTool(
      createStopAgentTool({
        subagents: capability({ stop: () => Promise.resolve(true) }),
      }),
      { name: "AGENT-1" }
    );

    expect(result.output).toBe("stopped AGENT-1");
    expect(result.metadata).toStrictEqual({ name: "AGENT-1", stopped: true });
  });

  test("does not claim to have stopped a subagent that already finished", async () => {
    const result = await runTool(
      createStopAgentTool({
        subagents: capability({ stop: () => Promise.resolve(false) }),
      }),
      { name: "AGENT-1" }
    );

    expect(result.output).toBe("AGENT-1 was not running");
    expect(result.metadata).toStrictEqual({ name: "AGENT-1", stopped: false });
  });
});
