import { executeTool, isExecutableTool } from "@ai-sdk/provider-utils";
import type { AgentStreamEvent } from "@workspace/agent-client";
import { getErrorMessage } from "@workspace/shared/errors";
import { asSchema } from "ai";
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
  ToolCallHookEvent,
  ToolStartDecision,
} from "../hooks-manager";
import { resolveToolStartDecision, TOOL_DENIED_TEXT } from "../hooks-manager";
import type { ToolApprovalPattern } from "../tool-approval";
import type { AgentToolSet, ToolExposure } from "../types";
import { getOwn } from "../utils/get-own";
import { generateEventId } from "../utils/id-util";

/** A tool call the model asked for and the agent — not the provider — runs. */
export type AgentToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

/**
 * 真正要跑的那次调用。有转调工具时，它和模型发出的那次不是同一个名字。
 *
 * `call-tool({ name, input })` 从模型那边看是一次调用，从工具那边看是另一次。
 * hook 和审批必须看到真实工具——注解在它身上——而历史保留模型用过的名字，助手
 * 消息和它的结果才对得上。
 */
export type CallTarget = {
  toolName: string;
  input: unknown;
};

/** 把模型的调用解析成要跑的那次；返回 undefined 表示「照原样执行」。 */
export type CallTargetResolver = (
  toolCall: AgentToolCall
) => CallTarget | undefined;

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
  /**
   * Agent 注册的审批函数。
   *
   * 它收到和 `pre_tool_call` 相同的调用信息。它的答案和钩子的答案一起
   * 折叠：函数的 `allow` 不能取消钩子的 `ask` 或 `deny`，函数的 `deny`
   * 也不会被钩子的 `allow` 取消。
   */
  decideToolApproval?: ToolApprovalPattern;
  skipApproval?: boolean;
  /**
   * 把模型的调用解析成真正要跑的那次调用。
   *
   * 没有解析器时两者相同。转调工具就是靠它把 `call-tool` 换成真实工具，
   * 让 hook 与审批看见带注解的那个名字。
   */
  resolveCallTarget?: CallTargetResolver;
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
 * 只留这一步声明给模型的工具。
 *
 * `deferred` 的工具仍然在真实的工具集里——agent 照旧按名字跑它——只是不交给
 * SDK。暴露方式只在这里被读一次，所以一个工具要么声明、要么藏起来，不会两边
 * 都在。
 */
export function declaredTools(
  tools: ToolSet,
  exposure: ReadonlyMap<string, ToolExposure>
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => exposure.get(name) !== "deferred")
  );
}

/**
 * Hands the SDK a tool set that can only describe tools, not run them.
 *
 * `streamText` executes any tool carrying an `execute`, which would put the
 * calls back out of reach of `pre_tool_call`. Dropping the function leaves the
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
 * Each call first goes through `pre_tool_call`, and every handler of it is
 * heard: a refusal anywhere in the run is the run's answer, so one hook cannot
 * be talked out of it by another that allowed the call. The agent's own
 * approval function answers for the call and is folded with the hooks' answers
 * under the same rule. If any call is left answered `ask`, the whole
 * batch is put to the user and nothing runs: the calls of one step are one
 * action, and half of it must not happen while the user is deciding. What comes
 * back then is
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
        target: targetOf(toolCall, input.resolveCallTarget),
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
 * One call together with what `pre_tool_call` said about it.
 *
 * The hooks have to be asked before anything runs: whether the batch is held is
 * known only once every one of them has answered, and a call that runs anyway
 * cannot be un-run.
 */
type ToolCallPlan = {
  toolCall: AgentToolCall;
  /** The call to run; equal to `toolCall` unless a route tool was resolved. */
  target: CallTarget;
  /** The decision, with an approval the user already gave folded in. */
  decision: ToolStartDecision | undefined;
  /** When the call was picked up, so its wall time still includes the hook. */
  startedAt: number;
};

/** 解析一次调用；没有解析结果时按模型发出的样子执行。 */
function targetOf(
  toolCall: AgentToolCall,
  resolve: CallTargetResolver | undefined
): CallTarget {
  const resolved = resolve?.(toolCall);

  return resolved ?? { toolName: toolCall.toolName, input: toolCall.input };
}

async function planToolCall(
  toolCall: AgentToolCall,
  input: ExecuteToolCallsInput
): Promise<ToolCallPlan> {
  const { sessionId, turnId, stepId, messages, hooks, extensionApi } = input;
  const startedAt = performance.now();
  const target = targetOf(toolCall, input.resolveCallTarget);

  // 请求带的是目标，不是模型发出的那次调用：看到 `call-tool` 的钩子或审批规则
  // 说不出它要跑哪个工具，而 MCP 的注解挂在真实名字上。
  const request: ToolCallHookEvent = {
    sessionId,
    turnId,
    stepId,
    toolCallId: toolCall.toolCallId,
    toolName: target.toolName,
    input: target.input,
    messages,
  };

  const decisions = await hooks.emitAsyncHooks(
    "pre_tool_call",
    request,
    extensionApi
  );
  // The agent's own function answers for this call. It is folded with the
  // hooks' answers rather than replacing them: an `allow` cannot undo a hook's
  // `ask` or `deny`, and a `deny` stops the call whatever a hook said.
  const policy = await input.decideToolApproval?.(request);
  const decision = resolveToolStartDecision(
    policy ? [...decisions, policy] : decisions
  );

  return { toolCall, target, decision, startedAt };
}

/**
 * Puts one call to the user.
 *
 * The `id` is the call's, so the client and the turn assembler address the same
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
 * The `id` is the call's, so the client and the turn assembler address the same
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
  const { toolCall, target, decision, startedAt } = plan;
  // `toolName` is the name the model used — it goes on the protocol events and
  // on the result part. `target` is what runs, and what the hooks were asked
  // about.
  const { toolCallId, toolName } = toolCall;
  const tool = getOwn(tools, target.toolName);

  const hookEvent = {
    sessionId,
    turnId,
    stepId,
    toolCallId,
    toolName: target.toolName,
    input: target.input,
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
      "post_tool_call",
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
  // A route tool's input is the target's input for the same reason.
  const toolInput = target.input;
  const routed = target.toolName !== toolName;

  try {
    // 服务端只校验过模型发出的那个外壳（`call-tool({name, input})`），真实工具
    // 的 schema 从未套用。校验放在这里，签名才算承诺而不只是提示。
    const runInput = routed
      ? await validateRoutedInput(tool, target.toolName, toolInput)
      : toolInput;
    const output = await runExecute(
      tool,
      target.toolName,
      runInput,
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
      // turn assembler folds onto the same part the final one lands on and the
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
      "post_tool_call",
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
          input: runInput,
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
      "post_tool_call",
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

/**
 * 按真实工具自己的 schema 校验一次转调来的入参。
 *
 * 服务端校验的是模型发出的那次调用，而转调的那次是 `call-tool({ name, input })`
 * ——里面的 `input` 一路没人看。这里返回校验后的值，所以 schema 声明的默认值和
 * 直接调用一样会被补上。
 *
 * 只校验「能校验」的 schema。MCP 工具带的是服务器给的 JSON Schema，而这个 SDK
 * 的 `jsonSchema()` 不提供校验器，它的入参仍然原样送到服务器，由服务器拒绝，
 * 再把错误文本交回模型。
 */
async function validateRoutedInput(
  tool: Tool | undefined,
  toolName: string,
  input: unknown
): Promise<unknown> {
  if (!tool || tool.inputSchema === undefined) {
    return input;
  }

  const schema = asSchema(tool.inputSchema);
  // 没有 `validate` 的 schema 什么都证明不了，只能放行：MCP 的 JSON Schema
  // 就是这一档，它的入参由服务器自己拒绝。
  if (!schema.validate) {
    return input;
  }

  const result = await schema.validate(input);

  if (result.success) {
    return result.value;
  }

  throw new TypeError(
    `Input for "${toolName}" does not match its schema: ${describeValidationError(result.error)}`
  );
}

/** 校验失败时给模型看的那句话：哪个参数、为什么。 */
function describeValidationError(error: unknown): string {
  const { issues } = error as {
    issues?: { message?: string; path?: unknown[] }[];
  };

  if (!Array.isArray(issues) || issues.length === 0) {
    return getErrorMessage(error) ?? "input is not valid";
  }

  return issues
    .map(
      (issue) =>
        `${(issue.path ?? []).join(".") || "input"}: ${issue.message ?? "is not valid"}`
    )
    .join("; ");
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
