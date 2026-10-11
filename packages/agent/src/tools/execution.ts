import { executeTool, isExecutableTool } from "@ai-sdk/provider-utils";
import type { AgentStreamEvent } from "@workspace/agent-client";
import { getErrorMessage } from "@workspace/shared/errors";
import type {
  ModelMessage,
  Tool,
  ToolExecutionOptions,
  ToolResultPart,
  ToolSet,
} from "ai";
import { createToolModelOutput } from "ai/internal";

import type { AgentContext } from "../agent-context";
import type {
  ExtensionAPI,
  HooksManager,
  ToolBeforeDecision,
} from "../hooks-manager";
import { TOOL_DENIED_TEXT } from "../hooks-manager";
import type { AgentToolSet } from "../types";
import { getOwn } from "../utils/get-own";

/** A tool call the model asked for and the agent — not the provider — runs. */
export type AgentToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

/** How one tool call, or the decision not to run it, ended. */
export type ToolCallOutcome = {
  toolCallId: string;
  type: "result" | "error" | "denied";
  /** The tool's return value, when it produced one. */
  output?: unknown;
  /** Why it failed, in the model's own wording. */
  errorText?: string;
  durationMs: number;
};

export type ExecuteToolCallsInput = {
  /** The real tool set, `execute` included — the SDK gets a stripped copy. */
  tools: ToolSet;
  /** The calls to run. An invalid call belongs to the SDK, not here. */
  toolCalls: readonly AgentToolCall[];
  sessionId: string;
  turnId: string;
  stepId: string;
  /**
   * The history the calls were made against — what the hooks and the tools
   * themselves see. The assistant message asking for the calls is not in it.
   */
  messages: ModelMessage[];
  context: AgentContext;
  hooks: HooksManager;
  extensionApi: ExtensionAPI;
  abortSignal?: AbortSignal;
  /** Publishes a protocol event onto the turn's stream. */
  write: (event: AgentStreamEvent<AgentToolSet>) => Promise<void>;
};

export type ExecuteToolCallsResult = {
  outcomes: ToolCallOutcome[];
  /**
   * The `tool` message the next step needs, or an empty array when there was
   * nothing to report. One message holding every result mirrors what the SDK
   * builds for its own step loop.
   */
  toolMessages: ModelMessage[];
  /** Per-call wall time, for the step's `performance.toolExecutionMs`. */
  toolExecutionMs: Record<string, number>;
};

const elapsed = (startedAt: number) =>
  Math.round(performance.now() - startedAt);

/**
 * Hands the SDK a tool set that can only describe tools, not run them.
 *
 * `streamText` executes any tool carrying an `execute`, which would put the
 * calls back out of reach of `tool:before`. Dropping the function leaves the
 * schema, the description and `toModelOutput` intact, so the model still sees
 * the same tools and the step still ends with `tool-calls` — the calls are
 * simply left for {@link executeToolCalls} to run.
 *
 * This is a copy: the agent keeps the original set, `execute` and all.
 */
export function stripToolExecution(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const { execute: _execute, ...rest } = tool;
      return [name, rest];
    })
  );
}

/**
 * Runs one step's tool calls, all at once.
 *
 * Each call goes through `tool:before`, then through the tool's own `execute`,
 * and reports what happened three ways: as a protocol event for the client, as
 * a `tool` message for the model, and as a number for the step's performance.
 * `Promise.all` is what makes the calls concurrent; it also keeps the results
 * in tool-call order no matter which call finishes first.
 *
 * Every call comes back with an outcome — a denial and a failure are as much
 * an outcome as a result — so the caller can tell which calls are still
 * unanswered by comparing the two lists.
 */
export async function executeToolCalls(
  input: ExecuteToolCallsInput
): Promise<ExecuteToolCallsResult> {
  const runs = await Promise.all(
    input.toolCalls.map((toolCall) => runToolCall(toolCall, input))
  );

  const outcomes = runs.map((run) => run.outcome);
  const parts = runs.map((run) => run.part);

  return {
    outcomes,
    toolMessages: parts.length > 0 ? [{ role: "tool", content: parts }] : [],
    toolExecutionMs: Object.fromEntries(
      outcomes.map((outcome) => [outcome.toolCallId, outcome.durationMs])
    ),
  };
}

type ToolRun = {
  outcome: ToolCallOutcome;
  part: ToolResultPart;
};

async function runToolCall(
  toolCall: AgentToolCall,
  input: ExecuteToolCallsInput
): Promise<ToolRun> {
  const {
    tools,
    sessionId,
    turnId,
    stepId,
    messages,
    context,
    hooks,
    extensionApi,
    abortSignal,
    write,
  } = input;
  const { toolCallId, toolName } = toolCall;
  const tool = getOwn(tools, toolName);
  const startedAt = performance.now();

  const hookEvent = {
    sessionId,
    turnId,
    stepId,
    toolCallId,
    toolName,
    input: toolCall.input,
    messages,
  };

  // `emitFirst`, not `emit`: the handler that runs first is the most
  // authoritative one, so a high-priority denial must not be overridden by a
  // lower-priority allowance.
  const decision: ToolBeforeDecision | undefined = await hooks.emitFirst(
    "tool:before",
    hookEvent,
    extensionApi
  );

  if (decision?.decision === "deny") {
    const durationMs = elapsed(startedAt);

    await write({
      type: "tool.output-denied",
      turnId,
      stepId,
      createdAt: Date.now(),
      toolCallId,
      toolName,
      providerExecuted: false,
    } as AgentStreamEvent<AgentToolSet>);
    await hooks.emit(
      "tool:after",
      { ...hookEvent, outcome: "denied", durationMs },
      extensionApi
    );

    return {
      outcome: { toolCallId, type: "denied", durationMs },
      part: {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "error-text", value: TOOL_DENIED_TEXT },
      },
    };
  }

  // A hook may rewrite the input, but only the execution sees the rewrite: the
  // call the model made — and the one the transcript replays — keeps the
  // original, so the assistant message and its tool message still line up.
  const toolInput =
    decision?.decision === "allow" && decision.input !== undefined
      ? decision.input
      : toolCall.input;

  try {
    const output = await runExecute(tool, toolName, toolInput, {
      toolCallId,
      messages,
      abortSignal,
      context,
    });
    const durationMs = elapsed(startedAt);

    await write({
      type: "tool.result",
      turnId,
      stepId,
      createdAt: Date.now(),
      toolCallId,
      toolName,
      input: toolCall.input,
      output,
      providerExecuted: false,
    } as AgentStreamEvent<AgentToolSet>);
    await hooks.emit(
      "tool:after",
      { ...hookEvent, input: toolInput, outcome: "result", output, durationMs },
      extensionApi
    );

    return {
      outcome: { toolCallId, type: "result", output, durationMs },
      part: {
        type: "tool-result",
        toolCallId,
        toolName,
        // The real tool is passed, `toModelOutput` included: it is what turns a
        // read-file result's attachments into model content.
        output: await createToolModelOutput({
          toolCallId,
          input: toolInput,
          output,
          tool,
          errorMode: "none",
        }),
      },
    };
  } catch (error) {
    const errorText = getErrorMessage(error);
    const durationMs = elapsed(startedAt);

    await write({
      type: "tool.error",
      turnId,
      stepId,
      createdAt: Date.now(),
      toolCallId,
      toolName,
      input: toolCall.input,
      error: errorText,
    } as AgentStreamEvent<AgentToolSet>);
    await hooks.emit(
      "tool:after",
      {
        ...hookEvent,
        input: toolInput,
        outcome: "error",
        errorText,
        durationMs,
      },
      extensionApi
    );

    return {
      outcome: { toolCallId, type: "error", errorText, durationMs },
      part: {
        type: "tool-result",
        toolCallId,
        toolName,
        output: await createToolModelOutput({
          toolCallId,
          input: toolInput,
          output: errorText,
          tool,
          errorMode: "text",
        }),
      },
    };
  }
}

async function runExecute(
  tool: Tool | undefined,
  toolName: string,
  toolInput: unknown,
  options: ToolExecutionOptions<AgentContext>
): Promise<unknown> {
  if (!isExecutableTool(tool)) {
    // A name the model invented, or a tool registered without an implementation.
    throw new TypeError(`No executable tool named "${toolName}".`);
  }

  // `executeTool` normalizes the three shapes a tool may return — a value, a
  // promise, or a stream of results — yielding every part but the last as
  // `preliminary`. The protocol carries no preliminary, so only the final
  // output is kept; a tool that only ever streams would come back empty, which
  // none of this package's tools do today.
  //
  // The SDK types a tool's context as `never` whenever the context type has an
  // index signature — ours does — so the options object it accepts is spelled
  // apart from the one the tools are written against, though it is the same
  // object at runtime.
  let output: unknown;
  for await (const { type, output: value } of executeTool({
    tool,
    input: toolInput,
    options: options as ToolExecutionOptions<never>,
  })) {
    if (type === "final") {
      output = value;
    }
  }
  return output;
}
