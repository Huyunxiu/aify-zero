import { AgentTurnBuilder } from "@workspace/agent-client";
import type { AgentStreamEvent } from "@workspace/agent-client";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import type { AgentContext } from "../../src/agent-context.js";
import type { ToolBeforeDecision } from "../../src/hooks-manager.js";
import { HooksManager, TOOL_DENIED_TEXT } from "../../src/hooks-manager.js";
import type { AgentToolCall } from "../../src/tools/execution.js";
import {
  executeToolCalls,
  stripToolExecution,
} from "../../src/tools/execution.js";
import type { AgentToolSet } from "../../src/types.js";

const turnId = "turn-1";
const stepId = "step-1";
const sessionId = "session-1";

// The executor only reads `workdir` off the context; the class it is cast from
// is built by the host, not by the loop under test.
const context = { workdir: "/tmp" } as unknown as AgentContext;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type EchoOutput = { output: string; code: "ok" };

/** A tool that echoes its input back, so a rewrite is visible in the output. */
const echoTool = (
  execute: (input: { value: string }) => EchoOutput | Promise<EchoOutput>
) =>
  tool({
    description: "Echoes a value.",
    inputSchema: z.object({ value: z.string() }),
    execute,
    toModelOutput: ({ output }) => ({ type: "text", value: output.output }),
  });

/** A tool that takes `ms` to finish and returns its name. */
const slowTool = (name: string, ms: number) =>
  tool({
    description: `Waits ${ms}ms.`,
    inputSchema: z.object({}),
    execute: async () => {
      await sleep(ms);
      return { output: name, code: "ok" as const };
    },
    toModelOutput: ({ output }) => ({ type: "text", value: output.output }),
  });

function run(
  tools: ToolSet,
  toolCalls: AgentToolCall[],
  hooks = new HooksManager()
) {
  const events: AgentStreamEvent<AgentToolSet>[] = [];

  return executeToolCalls({
    tools,
    toolCalls,
    sessionId,
    turnId,
    stepId,
    messages: [],
    context,
    hooks,
    extensionApi: {},
    write: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  }).then((result) => ({ result, events }));
}

describe(stripToolExecution, () => {
  test("drops execute and leaves everything else, original included", () => {
    const original = {
      echo: echoTool(({ value }) => ({
        output: value,
        code: "ok" as const,
      })),
    };
    const stripped = stripToolExecution(original);

    expect(stripped.echo).not.toHaveProperty("execute");
    expect(stripped.echo).toHaveProperty("description", "Echoes a value.");
    expect(stripped.echo).toHaveProperty("inputSchema");
    expect(stripped.echo).toHaveProperty("toModelOutput");

    // The agent keeps the real set: stripping is what makes the SDK hand the
    // calls back to us, so the tool that runs must still be executable.
    expect(original.echo.execute).toBeTypeOf("function");
  });
});

describe(executeToolCalls, () => {
  test("runs a step's calls concurrently", async () => {
    const startedAt = performance.now();
    const { result } = await run(
      { a: slowTool("a", 100), b: slowTool("b", 100) },
      [
        { toolCallId: "call-a", toolName: "a", input: {} },
        { toolCallId: "call-b", toolName: "b", input: {} },
      ]
    );
    const total = performance.now() - startedAt;

    expect(result.outcomes.map((outcome) => outcome.type)).toStrictEqual([
      "result",
      "result",
    ]);
    // Serially this would take two waits; concurrently it pays for one.
    expect(total).toBeLessThan(180);
  });

  test("reports a result as a protocol event and a tool message", async () => {
    const { result, events } = await run(
      {
        echo: echoTool(({ value }) => ({
          output: `echo:${value}`,
          code: "ok" as const,
        })),
      },
      [{ toolCallId: "call-1", toolName: "echo", input: { value: "hi" } }]
    );

    expect(events).toStrictEqual([
      {
        type: "tool.result",
        turnId,
        stepId,
        createdAt: expect.any(Number),
        toolCallId: "call-1",
        toolName: "echo",
        input: { value: "hi" },
        output: { output: "echo:hi", code: "ok" },
        providerExecuted: false,
      },
    ]);

    // The model-facing output goes through the tool's own `toModelOutput`.
    expect(result.toolMessages).toStrictEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "echo",
            output: { type: "text", value: "echo:hi" },
          },
        ],
      },
    ]);
    expect(result.toolExecutionMs["call-1"]).toBeGreaterThanOrEqual(0);
  });

  test("keeps the results in tool-call order however they finish", async () => {
    const { result } = await run(
      { slow: slowTool("slow", 80), fast: slowTool("fast", 0) },
      [
        { toolCallId: "call-slow", toolName: "slow", input: {} },
        { toolCallId: "call-fast", toolName: "fast", input: {} },
      ]
    );

    expect(result.outcomes.map((outcome) => outcome.toolCallId)).toStrictEqual([
      "call-slow",
      "call-fast",
    ]);
  });

  describe("tool:before", () => {
    test("a denial stops the call and answers the model with one", async () => {
      const hooks = new HooksManager();
      hooks.on("tool:before", () => ({ decision: "deny", reason: "not now" }));

      // Never expected to run: the denial is what this test is about.
      const execute = vi.fn<(input: { value: string }) => EchoOutput>();
      const { result, events } = await run(
        { echo: echoTool(execute) },
        [{ toolCallId: "call-1", toolName: "echo", input: { value: "hi" } }],
        hooks
      );

      expect(execute).not.toHaveBeenCalled();
      expect(events).toStrictEqual([
        {
          type: "tool.output-denied",
          turnId,
          stepId,
          createdAt: expect.any(Number),
          toolCallId: "call-1",
          toolName: "echo",
          providerExecuted: false,
        },
      ]);
      expect(result.outcomes).toStrictEqual([
        {
          toolCallId: "call-1",
          type: "denied",
          durationMs: expect.any(Number),
        },
      ]);
      expect(result.toolMessages).toStrictEqual([
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "echo",
              output: { type: "error-text", value: TOOL_DENIED_TEXT },
            },
          ],
        },
      ]);
    });

    test("the highest-priority handler decides", async () => {
      const hooks = new HooksManager();
      const lowPriority = vi.fn<() => ToolBeforeDecision>(() => ({
        decision: "allow",
      }));
      const highPriority = vi.fn<() => ToolBeforeDecision>(() => ({
        decision: "deny",
      }));

      hooks.on("tool:before", lowPriority, { priority: 0 });
      hooks.on("tool:before", highPriority, { priority: 10 });

      // Never expected to run: the high-priority denial is the answer.
      const execute = vi.fn<() => EchoOutput>();
      const { events } = await run(
        { echo: echoTool(execute) },
        [{ toolCallId: "call-1", toolName: "echo", input: { value: "hi" } }],
        hooks
      );

      // Both ran — the lower one may be listening for its side effect — but the
      // answer is the first one's, which is the opposite of `emit`'s rule.
      expect(highPriority).toHaveBeenCalledOnce();
      expect(lowPriority).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({ type: "tool.output-denied" });
    });

    test("a handler may rewrite the input the tool runs with", async () => {
      const hooks = new HooksManager();
      hooks.on("tool:before", () => ({
        decision: "allow",
        input: { value: "rewritten" },
      }));

      const received: string[] = [];
      const { events } = await run(
        {
          echo: echoTool(({ value }) => {
            received.push(value);
            return { output: value, code: "ok" as const };
          }),
        },
        [
          {
            toolCallId: "call-1",
            toolName: "echo",
            input: { value: "original" },
          },
        ],
        hooks
      );

      expect(received).toStrictEqual(["rewritten"]);
      // The call the model made is what the transcript keeps, so the event
      // carries the original input even though the execution saw the rewrite.
      expect(events[0]).toMatchObject({
        type: "tool.result",
        input: { value: "original" },
        output: { output: "rewritten", code: "ok" },
      });
    });

    test("a handler that abstains leaves the call alone", async () => {
      const hooks = new HooksManager();
      hooks.on("tool:before", () => {});

      const { events } = await run(
        {
          echo: echoTool(({ value }) => ({
            output: value,
            code: "ok" as const,
          })),
        },
        [{ toolCallId: "call-1", toolName: "echo", input: { value: "hi" } }],
        hooks
      );

      expect(events[0]).toMatchObject({ type: "tool.result" });
    });
  });

  test("a tool that throws becomes a tool error, not a failed step", async () => {
    const { result, events } = await run(
      {
        echo: echoTool(() => {
          throw new Error("boom");
        }),
      },
      [{ toolCallId: "call-1", toolName: "echo", input: { value: "hi" } }]
    );

    expect(events).toStrictEqual([
      {
        type: "tool.error",
        turnId,
        stepId,
        createdAt: expect.any(Number),
        toolCallId: "call-1",
        toolName: "echo",
        input: { value: "hi" },
        error: "boom",
      },
    ]);
    expect(result.outcomes).toStrictEqual([
      {
        toolCallId: "call-1",
        type: "error",
        errorText: "boom",
        durationMs: expect.any(Number),
      },
    ]);
    expect(result.toolMessages).toStrictEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "echo",
            output: { type: "error-text", value: "boom" },
          },
        ],
      },
    ]);
  });

  test("a tool the set does not have is an error, not a pass", async () => {
    const { result, events } = await run({}, [
      { toolCallId: "call-1", toolName: "invented", input: {} },
    ]);

    expect(events[0]).toMatchObject({
      type: "tool.error",
      toolName: "invented",
      error: 'No executable tool named "invented".',
    });
    expect(result.outcomes[0]).toMatchObject({ type: "error" });
  });

  test("reports nothing for a step with no calls", async () => {
    const { result, events } = await run({}, []);

    expect(events).toStrictEqual([]);
    expect(result.outcomes).toStrictEqual([]);
    expect(result.toolMessages).toStrictEqual([]);
    expect(result.toolExecutionMs).toStrictEqual({});
  });

  test("every call is answered, whatever its outcome", async () => {
    const hooks = new HooksManager();
    hooks.on("tool:before", (event) =>
      event.toolName === "denied" ? { decision: "deny" } : undefined
    );

    const { result } = await run(
      {
        echo: echoTool(({ value }) => ({
          output: value,
          code: "ok" as const,
        })),
        denied: echoTool(({ value }) => ({
          output: value,
          code: "ok" as const,
        })),
      },
      [
        { toolCallId: "call-1", toolName: "echo", input: { value: "a" } },
        { toolCallId: "call-2", toolName: "denied", input: { value: "b" } },
      ],
      hooks
    );

    // A denial is an answer: the model is told the call was refused, so the
    // loop can carry on rather than stopping on an unanswered call.
    expect(result.outcomes.map((outcome) => outcome.type)).toStrictEqual([
      "result",
      "denied",
    ]);
  });
});

describe("the synthesized events", () => {
  /** Builds the part the way the SDK's own chunks would, then feeds ours in. */
  async function buildPart(
    events: AgentStreamEvent<AgentToolSet>[]
  ): Promise<string> {
    const builder = new AgentTurnBuilder<AgentToolSet>({ turns: [] });

    await builder.push({
      type: "turn.start",
      id: turnId,
      turnType: "assistant",
      createdAt: 0,
    });
    await builder.push({
      type: "step.start",
      id: stepId,
      stepType: "assistant",
      model: "test-model",
      turnId,
      createdAt: 0,
    });
    await builder.push({
      type: "tool.input-start",
      id: "call-1",
      toolName: "echo",
      turnId,
      stepId,
      createdAt: 0,
    });
    await builder.push({
      type: "tool.call",
      toolCallId: "call-1",
      toolName: "echo",
      input: { value: "hi" },
      turnId,
      stepId,
      createdAt: 0,
    } as AgentStreamEvent<AgentToolSet>);

    for (const event of events) {
      await builder.push(event);
    }

    const step = builder.turns[0]?.content[0];
    const part =
      step && "content" in step
        ? step.content.find((candidate) => candidate.type.startsWith("tool-"))
        : undefined;

    return (part && "state" in part ? part.state : undefined) ?? "missing";
  }

  test("land a successful call in output-available", async () => {
    const { events } = await run(
      {
        echo: echoTool(({ value }) => ({
          output: value,
          code: "ok" as const,
        })),
      },
      [{ toolCallId: "call-1", toolName: "echo", input: { value: "hi" } }]
    );

    await expect(buildPart(events)).resolves.toBe("output-available");
  });

  test("land a failed call in output-error", async () => {
    const { events } = await run(
      {
        echo: echoTool(() => {
          throw new Error("boom");
        }),
      },
      [{ toolCallId: "call-1", toolName: "echo", input: { value: "hi" } }]
    );

    await expect(buildPart(events)).resolves.toBe("output-error");
  });

  test("land a denied call in output-denied", async () => {
    const hooks = new HooksManager();
    hooks.on("tool:before", () => ({ decision: "deny" }));

    const { events } = await run(
      { echo: echoTool(() => ({ output: "x", code: "ok" as const })) },
      [{ toolCallId: "call-1", toolName: "echo", input: { value: "hi" } }],
      hooks
    );

    await expect(buildPart(events)).resolves.toBe("output-denied");
  });
});
