import { describe, expect, test } from "vitest";

import type { AgentContext } from "../../src/agent-context.js";
import type { SubagentFactory } from "../../src/extensions/capabilities.js";
import { SUBAGENT_DEFINITIONS } from "../../src/subagent/definitions.js";
import { createTaskTool } from "../../src/tools/task.js";

type TaskResult = { output: string; code: "ok" | "error" };

/** The first thing the call says, which is all an unknown name has to say. */
async function first(
  tool: ReturnType<typeof createTaskTool>,
  input: { subagent_type: string; description: string; prompt: string }
): Promise<TaskResult> {
  const run = tool.execute?.(input, {
    toolCallId: "call-1",
    messages: [],
    // The unknown name is answered before the call needs any of the context.
    context: {} as AgentContext,
  }) as unknown as AsyncGenerator<TaskResult>;

  const step = await run.next();
  if (step.done) {
    throw new Error("the call finished without an answer");
  }
  return step.value;
}

describe("the task tool", () => {
  test("refuses a subagent name it does not have", async () => {
    const started: string[] = [];
    const subagents = {
      start: () => {
        started.push("start");
        throw new Error("a name the session does not have must not start one");
      },
    } as unknown as SubagentFactory;

    const tool = createTaskTool({
      transcript: { turns: () => [] },
      subagents,
      definitions: SUBAGENT_DEFINITIONS,
    });

    const result = await first(tool, {
      subagent_type: "explor",
      description: "find the seam",
      prompt: "Find it.",
    });

    // A misspelt name is an error the model can act on, not a different agent
    // that quietly does the work.
    expect(result.code).toBe("error");
    expect(result.output).toContain('No subagent named "explor"');
    expect(result.output).toContain("explore");
    expect(started).toStrictEqual([]);
  });
});
