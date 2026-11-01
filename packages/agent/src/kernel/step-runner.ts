import { findToolPartByToolCallId } from "@workspace/agent-client";
import type {
  AgentRuntimeContext,
  AgentStep,
  AgentStreamEvent,
} from "@workspace/agent-client";
import { ModelEffort } from "@workspace/shared/constants";
import { isStepCount, streamText } from "ai";
import type {
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  StepResultPerformance,
  TextStreamPart,
  ToolContent,
  ToolSet,
} from "ai";
import { collectToolApprovals } from "ai/internal";

import type { AgentContext } from "../agent-context";
import type { AgentSession } from "../agent-session";
import type {
  HookContext,
  HooksManager,
  RuntimeSettings,
  StepStartEvent,
} from "../hooks-manager";
import { applyRuntimeSettingsPatches } from "../hooks-manager";
import { executeToolCalls, stripToolExecution } from "../tools/execution";
import type { AgentToolSet } from "../types";
import { toAgentEvent } from "../utils/to-agent-stream-event";
import type { ModelGateway } from "./model-gateway";
import type { TranscriptJournal } from "./transcript-journal";

/** What one completed step of the model loop reported back. */
export type AgentStepResult = {
  /** The step's history, including its own assistant and tool messages. */
  readonly messages: ModelMessage[];
  /** This step's usage alone; the turn loop totals it across steps. */
  readonly usage: LanguageModelUsage;
  readonly finishReason: FinishReason;
  readonly rawFinishReason: string | undefined;
  /**
   * Whether every client tool call this step issued came back with a result —
   * the loop's continuation rule.
   */
  readonly toolCallsResolved: boolean;
  /** 这一步是否发起了 client 工具调用。 */
  readonly hadClientToolCalls: boolean;
  /**
   * 是否有非法或没有返回结果的 client 工具调用。
   *
   * 这类 step 的历史不完整，不能在上面追加引导消息；回合在这里结束，残留的
   * next-step 消息由收尾逻辑提升为 next-turn。
   */
  readonly unresolvedToolCalls: boolean;
  /**
   * Whether the step's calls were held for the user to approve. The turn ends
   * on this rather than continuing: there is nothing for the model to read
   * until the user answers, and the answers arrive on the next stream.
   */
  readonly awaitingApproval: boolean;
};

/** What one call of {@link StepRunner.run} reported back to the turn loop. */
export type StepOutcome =
  | { readonly ok: true; readonly result: AgentStepResult }
  /** The turn was aborted: nothing failed, the caller stopped it. */
  | { readonly ok: false; readonly reason: "aborted" }
  /** The model call failed, or the model ended the step with an error. */
  | { readonly ok: false; readonly reason: "error"; readonly error: unknown };

export type StepInput = {
  readonly turnId: string;
  readonly stepId: string;
  readonly stepType: AgentStep<AgentToolSet>["type"];
};

export interface StepRunnerDeps {
  gateway: ModelGateway;
  tools: ToolSet;
  session: AgentSession;
  context: AgentContext;
  hooks: HooksManager;
  extensionApi: HookContext;
  sessionId: string;
  journal: TranscriptJournal;
  /** turn / step 的默认运行时设置。 */
  runtimeSettings(): RuntimeSettings;
  /** 这个工具名是否要求用户先确认。 */
  requiresApproval(toolName: string): boolean;
  /** 模型报告上下文溢出时，交给压缩策略处理；返回是否已恢复。 */
  handleOverflow(error: unknown, turnId: string): Promise<boolean>;
}

/** Maps effort levels to the AI SDK's reasoning levels. */
const MODEL_EFFORT_TO_REASONING = {
  [ModelEffort.Default]: "provider-default",
  [ModelEffort.Off]: "none",
  [ModelEffort.Low]: "low",
  [ModelEffort.Medium]: "medium",
  [ModelEffort.High]: "high",
  [ModelEffort.Ultra]: "xhigh",
} as const;

/**
 * 一个模型步的执行器。
 *
 * 它只做三件事：发起一次 `streamText`，把流映射成协议事件，运行这一步的
 * 工具调用。turn 的循环、结束规则和压缩策略都在它之外。
 */
export class StepRunner {
  readonly #deps: StepRunnerDeps;

  constructor(deps: StepRunnerDeps) {
    this.#deps = deps;
  }

  /**
   * Runs one step and brackets it with the step hooks.
   *
   * `step_start` fires before the step streams; `step_end` fires once the step
   * has ended — finished, failed or aborted — so every start has its end and a
   * hook never has to infer from the turn's ending whether a step was cut
   * short.
   */
  async run(input: StepInput): Promise<StepOutcome> {
    const { sessionId, context, hooks, extensionApi } = this.#deps;
    const event: StepStartEvent = {
      sessionId,
      turnId: input.turnId,
      stepId: input.stepId,
      stepType: input.stepType,
      modelId: context.modelId,
    };

    // 补丁只作用于这一步：模型和系统提示都不写回 context 与 turn 的默认值，
    // 下一步仍然从默认值开始。
    const runtime: RuntimeSettings = applyRuntimeSettingsPatches(
      this.#deps.runtimeSettings(),
      await hooks.emitAsyncHooks("step_start", event, extensionApi)
    );

    const outcome = await this.#runStepCall(input, runtime);

    await hooks.emit(
      "step_end",
      {
        ...event,
        modelId: runtime.modelId,
        status: outcome.ok ? "done" : outcome.reason,
        ...(outcome.ok
          ? {
              usage: outcome.result.usage,
              finishReason: outcome.result.finishReason,
            }
          : {}),
      },
      extensionApi
    );

    return outcome;
  }

  /**
   * Issues a single `streamText` call, pipes its chunks into the open UI
   * message, and folds the step's assistant and tool messages back into the
   * history so the next step sees them.
   *
   * Reports how the step ended rather than failing the stream: an aborted or
   * failed step is an ending the turn has to record, not a reason for the reader
   * to be left without one.
   */
  async #runStepCall(
    input: StepInput,
    runtime: RuntimeSettings
  ): Promise<StepOutcome> {
    const {
      gateway,
      tools,
      session,
      context,
      hooks,
      extensionApi,
      sessionId,
      journal,
    } = this.#deps;
    const { turnId, stepId } = input;
    const model = gateway.languageModel(runtime.modelId);
    const messages = session.modelMessages;

    await context.controller?.write({
      type: "step.start",
      stepType: "assistant",
      model: runtime.modelId,
      turnId,
      stepId,
      createdAt: Date.now(),
    });

    // 处理工具调用
    // A stream that carries approvals is a resumption: a previous turn's step
    // stopped with calls the user has now answered, and those calls run here,
    // before the model is asked anything, so the history the model is about to
    // read has their results in it.
    //
    // `pre_tool_call` had its say when the calls were held — the answers are
    // what decides them now, which is why the approved ids are handed over
    // rather than the hooks being asked the same question twice.
    const { approvedToolApprovals, deniedToolApprovals } =
      collectToolApprovals<AgentToolSet>({ messages });

    if (approvedToolApprovals.length > 0 || deniedToolApprovals.length > 0) {
      const toolCallId =
        approvedToolApprovals[0]?.toolCall.toolCallId ||
        deniedToolApprovals[0]?.toolCall.toolCallId;
      const result = findToolPartByToolCallId(session.turns, toolCallId);
      const askedTurnId = result?.turn.id ?? turnId;
      const askedStepId = result?.step.id ?? stepId;

      const localDeniedToolApprovals = deniedToolApprovals.filter(
        (toolApproval) => toolApproval.toolCall.providerExecuted !== true
      );
      const localDeniedToolApprovalsWithoutResults =
        localDeniedToolApprovals.filter(
          (toolApproval) => toolApproval.existingToolResult === undefined
        );
      const deniedProviderExecutedToolApprovals = deniedToolApprovals.filter(
        (toolApproval) => toolApproval.toolCall.providerExecuted === true
      );

      for (const toolApproval of [
        ...localDeniedToolApprovals,
        ...deniedProviderExecutedToolApprovals,
      ]) {
        await context.controller?.write({
          type: "tool.output-denied",
          turnId: askedTurnId,
          stepId: askedStepId,
          createdAt: Date.now(),
          toolCallId: toolApproval.toolCall.toolCallId,
          toolName: toolApproval.toolCall.toolName,
          providerExecuted: false,
        } as AgentStreamEvent<AgentToolSet>);
      }

      const localApprovedToolApprovals = approvedToolApprovals.filter(
        (toolApproval) => toolApproval.toolCall.providerExecuted !== true
      );
      const localToolContent: ToolContent = [];

      if (localApprovedToolApprovals.length > 0) {
        const execution = await executeToolCalls({
          tools,
          toolCalls: localApprovedToolApprovals.map(
            (toolApproval) => toolApproval.toolCall
          ),
          sessionId,
          turnId: askedTurnId,
          stepId: askedStepId,
          messages,
          context,
          hooks,
          extensionApi,
          abortSignal: context.abortSignal,
          write: (event) =>
            context.controller?.write(event) ?? Promise.resolve(),
          skipApproval: true,
        });

        for (const message of execution.toolMessages) {
          if (message.role === "tool") {
            localToolContent.push(...message.content);
          }
        }

        if (result) {
          const previousPerformance = result?.step.metadata?.performance;
          const performance = {
            ...previousPerformance,
            toolExecutionMs: {
              ...previousPerformance?.toolExecutionMs,
              ...execution.toolExecutionMs,
            },
          } as StepResultPerformance;

          await context.controller?.write({
            stepId: askedStepId,
            turnId: askedTurnId,
            type: "step.metadata",
            createdAt: Date.now(),
            metadata: { performance },
          });
        }
      }

      // A refusal the user gave is reported to the model as an execution that
      // was turned down, which is what the SDK's own loop would have written.
      for (const toolApproval of localDeniedToolApprovalsWithoutResults) {
        localToolContent.push({
          type: "tool-result",
          toolCallId: toolApproval.toolCall.toolCallId,
          toolName: toolApproval.toolCall.toolName,
          output: {
            type: "execution-denied",
            reason: toolApproval.approvalResponse.reason,
          },
        });
      }

      if (localToolContent.length > 0) {
        messages.push({
          role: "tool",
          content: localToolContent,
        });
      }

      // 工具结果写回的是当初挂起调用的旧 step；journal 只写这一条，避免把
      // 同一 turn 里早已落库的其他 step 也带上一遍。
      await journal.persistStep(askedTurnId, askedStepId);
    }

    // 大模型调用
    let result;
    try {
      result = streamText<ToolSet, AgentRuntimeContext>({
        instructions: runtime.instructions,
        model,
        // The SDK is given tools it can only describe: an `execute` in this set
        // would have it run the calls itself, out of `pre_tool_call`'s reach.
        tools: stripToolExecution(tools),
        stopWhen: isStepCount(1),
        reasoning: context.modelEffort
          ? MODEL_EFFORT_TO_REASONING[context.modelEffort]
          : undefined,
        messages,
        abortSignal: context.abortSignal,
        include: {
          requestBody: true,
        },
      });
    } catch (error) {
      console.error(
        "agent#runStep streamText error.",
        context.abortSignal?.aborted,
        error
      );
      return await this.#stepFailure(error, turnId);
    }

    // A provider that fails mid-stream reports it as an `error` chunk, which the
    // protocol forwards as a part; keeping the last one lets the turn carry the
    // reason, which is known nowhere else.
    let streamError: unknown;

    // 大模型流处理
    const reader = result.stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value.type === "error") {
          streamError = value.error;
          console.error(
            "agent#runStep stream event error",
            context.abortSignal?.aborted,
            value.error
          );
        }
        // `streamText` is called with the plain `ToolSet`, so its chunks are
        // typed that way; the protocol wants them as the agent's own tool set.
        const event = toAgentEvent<AgentToolSet>(
          turnId,
          stepId,
          value as TextStreamPart<AgentToolSet>
        );
        if (event) {
          await context.controller?.write(event);
        }
      }
    } catch (error) {
      console.error(
        "agent#runStep reader error.",
        context.abortSignal?.aborted,
        streamError,
        error
      );
      // An abort surfaces here as the stream is torn down.
      return context.abortSignal?.aborted
        ? { ok: false, reason: "aborted" }
        : await this.#stepFailure(streamError ?? error, turnId);
    } finally {
      reader.releaseLock();
    }

    try {
      const [step, responseMessages] = await Promise.all([
        result.finalStep,
        result.responseMessages,
      ]);
      const { finishReason, rawFinishReason, usage, toolCalls } = step;

      // The step did end, but a step the model ended with `error` has no calls
      // worth running and cannot be reported as a whole turn either.
      if (finishReason === "error") {
        await context.controller?.write({
          stepId,
          turnId,
          type: "step.finish",
          createdAt: Date.now(),
          usage: step.usage,
          finishReason: step.finishReason,
          rawFinishReason: step.rawFinishReason,
          providerMetadata: step.providerMetadata,
          status: "done",
          metadata: { performance: step.performance },
        });

        return await this.#stepFailure(
          streamError ?? new Error("The model stream failed."),
          turnId
        );
      }

      // The calls this loop owns. A provider-executed call arrives with its
      // result already attached, and one the model got wrong is the SDK's to
      // report: it emits a `tool.error` of its own for those, but no matching
      // tool message, which is why they can never count as answered below.
      const clientToolCalls = toolCalls.filter(
        (call) => call.providerExecuted !== true
      );

      const execution = await executeToolCalls({
        tools,
        toolCalls: clientToolCalls.filter((call) => call.invalid !== true),
        sessionId,
        turnId,
        stepId,
        messages,
        context,
        hooks,
        extensionApi,
        abortSignal: context.abortSignal,
        requiresApproval: (name) => this.#deps.requiresApproval(name),
        write: (event) => context.controller?.write(event) ?? Promise.resolve(),
      });

      // A stop during the calls is the turn's ending, not a step's: the run
      // returns the way the reader loop's abort does, leaving the step pending
      // for `settle` to close. The events above have already been sent, so the
      // calls that did finish are on the reader's screen.
      if (context.abortSignal?.aborted) {
        return { ok: false, reason: "aborted" };
      }

      await context.controller?.write({
        stepId,
        turnId,
        type: "step.finish",
        createdAt: Date.now(),
        usage: step.usage,
        // The SDK times only the tools it runs itself, and these are no longer
        // among them, so the durations come from the loop that ran them.
        finishReason: step.finishReason,
        rawFinishReason: step.rawFinishReason,
        providerMetadata: step.providerMetadata,
        status: "done",
        metadata: {
          performance: {
            ...step.performance,
            toolExecutionMs: {
              ...step.performance.toolExecutionMs,
              ...execution.toolExecutionMs,
            },
          },
        },
      });

      // What the SDK feeds its own next step: the assistant message for this
      // step, then a tool message for whatever the loop executed.
      const promptMessageCount = messages.length;
      messages.push(...responseMessages, ...execution.toolMessages);
      session.noteStepUsage(usage, promptMessageCount);

      const executableToolCalls = clientToolCalls.filter(
        (call) => call.invalid !== true
      );
      const hadClientToolCalls = clientToolCalls.length > 0;
      // 等待审批不是“历史坏了”：调用被挂起，答案会从下一次流回来。其余
      // 情况里，非法或没有结果的调用会让历史不完整。
      const unresolvedToolCalls =
        !execution.awaitingApproval &&
        (executableToolCalls.length !== clientToolCalls.length ||
          execution.outcomes.length !== executableToolCalls.length);

      // The step ends here either way — everything it streamed is on the wire —
      // but a held step ends the turn with it: the model has no results to read
      // and the user still has the calls to answer, which is the next stream.
      if (execution.awaitingApproval) {
        return {
          ok: true,
          result: {
            messages,
            usage,
            finishReason,
            rawFinishReason,
            toolCallsResolved: false,
            hadClientToolCalls,
            unresolvedToolCalls: false,
            awaitingApproval: true,
          },
        };
      }

      // The continuation rule, read off our own outcomes now that the SDK no
      // longer reports them: keep going only while every client tool call came
      // back. A denial is an answer — the model is told the call was refused —
      // but a call the model got wrong is not, and continuing there would send
      // an assistant tool call with no matching tool message.
      const toolCallsResolved = hadClientToolCalls && !unresolvedToolCalls;

      return {
        ok: true,
        result: {
          messages,
          usage,
          finishReason,
          rawFinishReason,
          toolCallsResolved,
          hadClientToolCalls,
          unresolvedToolCalls,
          awaitingApproval: false,
        },
      };
    } catch (error) {
      console.error(
        "agent#runStep stream final error.",
        context.abortSignal?.aborted,
        streamError,
        error
      );
      // The stream can fail before any step is recorded, which rejects the two
      // promises above instead of ending the reader loop.
      return context.abortSignal?.aborted
        ? { ok: false, reason: "aborted" }
        : await this.#stepFailure(streamError ?? error, turnId);
    }
  }

  async #stepFailure(error: unknown, turnId: string): Promise<StepOutcome> {
    const { context } = this.#deps;
    if (context.abortSignal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    if (await this.#deps.handleOverflow(error, turnId)) {
      return {
        ok: false,
        reason: "error",
        error: new Error(
          "The model's context window was exceeded. The history has been compacted; retry the request."
        ),
      };
    }

    return { ok: false, reason: "error", error };
  }
}
