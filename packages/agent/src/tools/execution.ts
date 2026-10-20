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
  HookContext,
  HooksManager,
  ToolBeforeDecision,
} from "../hooks-manager";
import { TOOL_DENIED_TEXT } from "../hooks-manager";
import type { AgentToolSet } from "../types";
import { getOwn } from "../utils/get-own";
import { generateEventId } from "../utils/id-util";

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
  extensionApi: HookContext;
  abortSignal?: AbortSignal;
  /** Publishes a protocol event onto the turn's stream. */
  write: (event: AgentStreamEvent<AgentToolSet>) => Promise<void>;
  skipApproval?: boolean;
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
  /**
   * Whether the calls were put to the user instead of run.
   *
   * A held batch has no results — `outcomes` then reports only the calls a hook
   * refused outright, which are an answer rather than a run, and the calls
   * waiting on the user are absent from it. The caller ends the turn on this:
   * the model has nothing to continue with until the user responds.
   */
  awaitingApproval: boolean;
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
 * Runs one step's tool calls, all at once — or holds every one of them back.
 *
 * Each call first goes through `tool:before`, and every handler of it is heard:
 * a refusal anywhere in the run is the run's answer, so one hook cannot be
 * talked out of it by another that allowed the call. If any call is left
 * answered `ask`, the whole batch is put to the user and nothing runs: the calls
 * of one step are one action, and half of it must not happen while the user is
 * deciding. What comes back then is
 * {@link ExecuteToolCallsResult.awaitingApproval}, holding an outcome for every
 * call a hook refused outright — a refusal is already an answer — and nothing
 * for the calls waiting on the user, which is how the caller can tell which of
 * them are still unanswered.
 *
 * Otherwise each call goes through the tool's own `execute` and reports what
 * happened three ways: as a protocol event for the client, as a `tool` message
 * for the model, and as a number for the step's performance. A tool that
 * reports part-way through adds events of the first kind only, marked
 * `preliminary` — nothing about them reaches the model or the step. `Promise.all`
 * is what makes the calls concurrent; it also keeps the results in tool-call
 * order no matter which call finishes first.
 */
export async function executeToolCalls(
  input: ExecuteToolCallsInput
): Promise<ExecuteToolCallsResult> {
  const plans: ToolCallPlan[] = input.skipApproval
    ? input.toolCalls.map((toolCall) => ({
        toolCall,
        decision: { decision: "allow" },
        startedAt: performance.now(),
      }))
    : await Promise.all(
        input.toolCalls.map((toolCall) => planToolCall(toolCall, input))
      );

  // One call to the user holds the batch, `allow` included: the user is asked
  // about the step's calls as a whole or not at all. The refusals still go out
  // — a hook that turned a call down answered it, and that answer is not the
  // user's to give or take away.
  if (plans.some((plan) => plan.decision?.decision === "ask")) {
    const runs = await Promise.all(
      plans
        .filter((plan) => plan.decision?.decision === "deny")
        .map((plan) => runToolCall(plan, input))
    );

    for (const plan of plans) {
      if (plan.decision?.decision === "ask") {
        await writeApprovalRequest(plan, input);
      } else if (plan.decision?.decision === "allow") {
        const approvalId = await writeApprovalRequest(plan, input);
        await writeApprovalResponse(approvalId, plan, input);
      }
    }

    return toResult(runs, true);
  }

  const runs = await Promise.all(plans.map((plan) => runToolCall(plan, input)));

  return toResult(runs, false);
}

function toResult(
  runs: ToolRun[],
  awaitingApproval: boolean
): ExecuteToolCallsResult {
  const outcomes = runs.map((run) => run.outcome);
  const parts = runs.map((run) => run.part);

  return {
    outcomes,
    toolMessages: parts.length > 0 ? [{ role: "tool", content: parts }] : [],
    toolExecutionMs: Object.fromEntries(
      outcomes.map((outcome) => [outcome.toolCallId, outcome.durationMs])
    ),
    awaitingApproval,
  };
}

type ToolRun = {
  outcome: ToolCallOutcome;
  part: ToolResultPart;
};

/**
 * One call together with what `tool:before` said about it.
 *
 * The hooks have to be asked before anything runs: whether the batch is held is
 * known only once every one of them has answered, and a call that runs anyway
 * cannot be un-run.
 */
type ToolCallPlan = {
  toolCall: AgentToolCall;
  /** The decision, with an approval the user already gave folded in. */
  decision: ToolBeforeDecision | undefined;
  /** When the call was picked up, so its wall time still includes the hook. */
  startedAt: number;
};

/**
 * Folds what every `tool:before` handler said into the one answer the call gets.
 *
 * The handlers do not outrank one another — they each hold a veto: a refusal
 * anywhere in the run is the run's answer, and no later `allow` talks it out of
 * one. An `ask` stands the same way, since a user answering over a hook's
 * objection is exactly what a refusal is meant to prevent. Priority only breaks
 * ties: the first refusal to have been returned is the one whose reason is
 * reported, and handlers that abstained contribute nothing.
 */
function resolveToolBeforeDecision(
  decisions: readonly ToolBeforeDecision[]
): ToolBeforeDecision | undefined {
  const denial = decisions.find((decision) => decision.decision === "deny");
  if (denial) {
    return denial;
  }

  if (decisions.some((decision) => decision.decision === "ask")) {
    return { decision: "ask" };
  }

  if (decisions.some((decision) => decision.decision === "allow")) {
    return { decision: "allow" };
  }

  return undefined;
}

async function planToolCall(
  toolCall: AgentToolCall,
  input: ExecuteToolCallsInput
): Promise<ToolCallPlan> {
  const { sessionId, turnId, stepId, messages, hooks, extensionApi } = input;
  const startedAt = performance.now();

  const decisions = await hooks.emitAsyncHooks(
    "tool:before",
    {
      sessionId,
      turnId,
      stepId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: toolCall.input,
      messages,
    },
    extensionApi
  );
  const decision = resolveToolBeforeDecision(decisions);

  if (
    toolCall.toolName === "write-file" ||
    toolCall.toolName === "delete-file"
  ) {
    return {
      toolCall,
      decision: { decision: "ask" },
      startedAt,
    };
  }

  return {
    toolCall,
    decision,
    startedAt,
  };
}

/**
 * Puts one call to the user.
 *
 * The `id` is the call's, so the client and the turn builder address the same
 * part the `tool.input-start` opened, while the approval id is what the answer
 * will name — kept apart from the call because the same call may be asked about
 * again on a later stream.
 */
async function writeApprovalRequest(
  plan: ToolCallPlan,
  input: ExecuteToolCallsInput
): Promise<string> {
  const { turnId, stepId, write } = input;

  const approvalId = generateEventId();

  await write({
    type: "tool.approval-request",
    id: plan.toolCall.toolCallId,
    approvalId,
    turnId,
    stepId,
    createdAt: Date.now(),
  });

  return approvalId;
}

/**
 * Puts one call to the user.
 *
 * The `id` is the call's, so the client and the turn builder address the same
 * part the `tool.input-start` opened, while the approval id is what the answer
 * will name — kept apart from the call because the same call may be asked about
 * again on a later stream.
 */
async function writeApprovalResponse(
  approvalId: string,
  plan: ToolCallPlan,
  input: ExecuteToolCallsInput
): Promise<void> {
  const { turnId, stepId, write } = input;

  await write({
    type: "tool.approval-response",
    id: plan.toolCall.toolCallId,
    approvalId,
    approved: true,
    turnId,
    stepId,
    createdAt: Date.now(),
  });
}

async function runToolCall(
  plan: ToolCallPlan,
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
  const { toolCall, decision, startedAt } = plan;
  const { toolCallId, toolName } = toolCall;
  const tool = getOwn(tools, toolName);

  const hookEvent = {
    sessionId,
    turnId,
    stepId,
    toolCallId,
    toolName,
    input: toolCall.input,
    messages,
  };

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
  const toolInput = toolCall.input;

  try {
    const output = await runExecute(
      tool,
      toolName,
      toolInput,
      {
        toolCallId,
        messages,
        abortSignal,
        context,
      },
      // A tool may report before it is done — `task` does, so a client can
      // follow the subagent it started while the call is still running. Such a
      // report is published as this call's own result, carrying `preliminary`:
      // the protocol's mark for a result that is not the outcome, which the
      // turn builder folds onto the same part the final one lands on and the
      // model never reads.
      async (preliminary) => {
        await write({
          type: "tool.result",
          turnId,
          stepId,
          createdAt: Date.now(),
          toolCallId,
          toolName,
          input: toolCall.input,
          output: preliminary,
          preliminary: true,
          providerExecuted: false,
        } as AgentStreamEvent<AgentToolSet>);
      }
    );
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
  options: ToolExecutionOptions<AgentContext>,
  onPreliminary: (output: unknown) => Promise<void>
): Promise<unknown> {
  if (!isExecutableTool(tool)) {
    // A name the model invented, or a tool registered without an implementation.
    throw new TypeError(`No executable tool named "${toolName}".`);
  }

  // `executeTool` normalizes the three shapes a tool may return — a value, a
  // promise, or a stream of results — yielding every part but the last as
  // `preliminary`. The preliminary ones are handed to the caller as they
  // arrive, so a tool that streams can be followed while it runs; the last is
  // the call's output, and it is the one the caller reports as the result.
  //
  // A streamed value is not held back to see whether it turns out to be the
  // last: the SDK reads a stream the same way, so the final value is announced
  // twice, once as a preliminary and once as the result. A tool that reports
  // nothing until it is done never reaches any of this — one `final` is all it
  // yields.
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
    } else {
      await onPreliminary(value);
    }
  }
  return output;
}
