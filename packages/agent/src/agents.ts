import { DevToolsTelemetry } from "@ai-sdk/devtools";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { findToolPartByToolCallId } from "@workspace/agent-client";
import type {
  AgentRuntimeContext,
  AgentStep,
  AgentStreamEvent,
  AgentTurn,
  AgentTurnStatus,
} from "@workspace/agent-client";
import type { TurnModel } from "@workspace/db";
import { ModelEffort } from "@workspace/shared/constants";
import { getErrorMessage } from "@workspace/shared/errors";
import { logger } from "@workspace/shared/logger";
import {
  APICallError,
  generateText,
  isStepCount,
  registerTelemetry,
  streamText,
} from "ai";
import type {
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  StepResultPerformance,
  TextStreamPart,
  Tool,
  ToolContent,
  ToolSet,
} from "ai";
import { collectToolApprovals } from "ai/internal";

import type { AgentContext } from "./agent-context";
import type { AgentSession } from "./agent-session";
import { ExtensionManager } from "./extensions/manager";
import type { Extension } from "./extensions/types";
import { HooksManager } from "./hooks-manager";
import type { HookContext } from "./hooks-manager";
import type { AgentStore, SessionEndStatus } from "./storage";
import { executeToolCalls, stripToolExecution } from "./tools/execution";
import type { AgentToolSet } from "./types";
import { generateEventId, generateStepId } from "./utils/id-util";
import { toAgentEvent } from "./utils/to-agent-stream-event";

registerTelemetry(DevToolsTelemetry());

export const TITLE_PROMPT = `Generate a very short session title (2-5 words max) based on the user's message.
Rules:
- Maximum 30 characters
- No quotes, colons, hashtags, or markdown
- Just the topic/intent, not a full sentence
- If the message is a greeting like "hi" or "hello", respond with just "New conversation"
- Be concise: "Weather in NYC" not "User asking about the weather in New York City"`;

// Maps effort levels to the AI SDK's reasoning levels.
const MODEL_EFFORT_TO_REASONING = {
  [ModelEffort.Default]: "provider-default",
  [ModelEffort.Off]: "none",
  [ModelEffort.Low]: "low",
  [ModelEffort.Medium]: "medium",
  [ModelEffort.High]: "high",
  [ModelEffort.Ultra]: "xhigh",
} as const;

// A session row borrows the ending the turn already recorded — `aborted` is the
// turn's word for a stop, `canceled` is the session's. `streaming` is listed
// only so this stays exhaustive over `AgentTurnStatus`; a turn is never read
// here before its finish.
//
// The session's `done` is not the turn's `done` flattened out: it also says the
// user has not looked yet, which is what the sidebar draws. Reading the session
// is what clears it back to `idle`.
const TURN_END_TO_SESSION_STATUS = {
  done: "done",
  wait_review: "wait_review",
  aborted: "canceled",
  error: "error",
  streaming: "error",
} as const satisfies Record<AgentTurnStatus["status"], SessionEndStatus>;

export type AgentOptions = {
  name: string;
  sessionId: string;
  session: AgentSession;
  tools?: ToolSet;
  store: AgentStore;
  systemPrompt?: string;
  context: AgentContext;
  hooks?: HooksManager;
  extensionApi?: HookContext;
  apiKey: string;
  apiUrl: string;
  providerId: string;
  modelId: string;
  modelEffort?: ModelEffort;
  /**
   * 这个 agent 所属的外部 abort scope，由派生它的父传进来。父停时它跟着停；和它
   * 自己的 `abort()` 是并集而不是替代，所以子 agent 仍然能被单独停掉。
   */
  abortSignal?: AbortSignal;
};

export type AgentStreamOptions = {
  modelId: string;
  turns: AgentTurn<AgentToolSet>[];
  /**
   * How the turn ended, so the caller can settle the session it belongs to. The
   * outcome is only known here, once the turn has run.
   */
  onFinish: (status: SessionEndStatus) => Promise<void>;
};

type AgentTurnInput = {
  readonly title?: string;
  readonly turnType: AgentTurn<AgentToolSet>["type"];
  readonly turnId: string;
  readonly parentId?: string;
};

type AgentStepInput = AgentTurnInput & {
  readonly stepId: string;
  readonly stepType: AgentStep<AgentToolSet>["type"];
};

/** What one completed step of the model loop reported back. */
export type AgentStepResult = {
  /** The step's history, including its own assistant and tool messages. */
  readonly messages: ModelMessage[];
  /** This step's usage alone; {@link Agent.#runTurn} totals it across steps. */
  readonly usage: LanguageModelUsage;
  readonly finishReason: FinishReason;
  readonly rawFinishReason: string | undefined;
  /**
   * Whether every client tool call this step issued came back with a result —
   * the loop's continuation rule.
   */
  readonly toolCallsResolved: boolean;
  /**
   * Whether the step's calls were held for the user to approve. The turn ends
   * on this rather than continuing: there is nothing for the model to read
   * until the user answers, and the answers arrive on the next stream.
   */
  readonly awaitingApproval: boolean;
};

/** What one call of {@link Agent.#runStep} reported back to the turn loop. */
type StepOutcome =
  | { readonly ok: true; readonly result: AgentStepResult }
  /** The turn was aborted: nothing failed, the caller stopped it. */
  | { readonly ok: false; readonly reason: "aborted" }
  /** The model call failed, or the model ended the step with an error. */
  | { readonly ok: false; readonly reason: "error"; readonly error: unknown };

export class Agent {
  name: string;
  sessionId: string;
  systemPrompt?: string;
  tools: ToolSet;

  store: AgentStore;
  hooks: HooksManager;
  extensionApi: HookContext;

  apiKey: string;
  apiUrl: string;
  providerId: string;
  provider: OpenAICompatibleProvider;

  context: AgentContext;
  session: AgentSession;

  readonly #abortController = new AbortController();
  /**
   * 扩展管理器。工具、hook 和系统提示片段在注册时立即生效；扩展自己的
   * 资源由扩展持有，Agent 不关心。
   */
  readonly extensions: ExtensionManager;
  /** 同一个 agent 同时只跑一个 turn。 */
  #running = false;
  /** 本 turn 拼接好的系统提示；turn 开始前算一次，turn 内保持稳定。 */
  #instructions?: string;

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.sessionId = options.sessionId;
    this.systemPrompt = options.systemPrompt;
    this.tools = options.tools ?? {};
    this.store = options.store;
    this.hooks = options.hooks ?? new HooksManager();
    this.extensionApi = options.extensionApi ?? {};
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl;
    this.providerId = options.providerId;

    this.context = options.context;
    this.context.modelId = options.modelId;
    this.context.modelEffort = options.modelEffort;
    // 这一轮的 abort scope 属于跑它的 agent：`abort()` 是入口，每一步都从 context
    // 上把 signal 读回去。子 agent 由父把自己的 signal 传进来，两者取并集——父一停
    // 它就跟着停，而它自己的 `abort()` 仍然独立生效。
    this.context.abortSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, this.#abortController.signal])
      : this.#abortController.signal;
    this.session = options.session;
    this.extensions = new ExtensionManager({
      agent: {
        name: this.name,
        sessionId: this.sessionId,
        projectDirs: this.context.projectDirs,
        sessionDir: this.context.sessionDir,
      },
      tools: this.tools,
      registerTool: (name, tool) => {
        this.registerTool(name, tool);
      },
      unregisterTool: (name) => {
        this.unregisterTool(name);
      },
      hooks: this.hooks,
    });
    this.provider = createOpenAICompatible({
      apiKey: this.apiKey,
      baseURL: this.apiUrl,
      name: this.providerId,
    });
  }

  registerTool(name: string, tool: Tool) {
    this.tools[name] = tool;
  }

  unregisterTool(name: string) {
    // oxlint-disable-next-line typescript/no-dynamic-delete
    delete this.tools[name];
  }

  /**
   * 注册一个扩展。工具、hook 和系统提示片段在 `init` 期间立即生效；扩展
   * 自己加载的资源保存在扩展实例上。
   */
  async registerExtension(extension: Extension): Promise<void> {
    await this.extensions.add(extension);
    this.#syncPromptSections();
  }

  /** 卸载一个扩展；返回它是否存在。 */
  async disposeExtension(id: string): Promise<boolean> {
    const disposed = await this.extensions.dispose(id);
    this.#syncPromptSections();
    return disposed;
  }

  /** 按注册的逆序卸载全部扩展。 */
  async dispose(): Promise<void> {
    await this.extensions.disposeAll();
    this.#syncPromptSections();
  }

  /**
   * 把当前的提示片段快照写进上下文，子 agent 派生时从这里继承。主 agent
   * 自己每次 `stream()` 都从管理器重新拼接，所以这里只是为了让子 agent
   * 拿到和父一致的片段。
   */
  #syncPromptSections(): void {
    this.context.systemPromptSections = this.extensions.listSections();
  }

  /**
   * Stops the turn this agent is running: the model call in flight, the tool
   * calls it has open, and the step loop all watch this signal. The turn still
   * finishes — with `status: "aborted"` — so the reader sees an ending.
   */
  abort(): void {
    this.#abortController.abort();
  }

  #getModel() {
    return this.provider.chatModel(this.context.modelId);
  }

  async stream(options: AgentStreamOptions) {
    if (this.#running) {
      throw new Error("agent is already running");
    }
    this.#running = true;
    try {
      return await this.#startStream(options);
    } catch (error) {
      // turn 还没交给后台任务就失败了，把锁还回去。
      this.#running = false;
      throw error;
    }
  }

  async #startStream({ turns, modelId, onFinish }: AgentStreamOptions) {
    this.context.modelId = modelId;
    this.session.turns = turns;
    // 提示片段在 turn 开始时拼一次：同一 turn 的每一步看到同一份提示词，
    // 扩展在 turn 中途改数据也不会让后续步骤的缓存失效。
    this.#instructions = this.extensions.renderSystemPrompt(
      this.systemPrompt ?? ""
    );

    const mostRecentTurn = turns.at(-1);
    if (!mostRecentTurn) {
      throw new Error("no message.");
    }

    await this.hooks.emit(
      "session_start",
      {
        sessionId: this.sessionId,
        name: this.name,
        projectDirs: this.context.projectDirs,
        sessionDir: this.context.sessionDir,
      },
      this.extensionApi
    );

    const session = await this.store.getSessionById(this.sessionId);
    if (!session) {
      // The title stays empty until the AI-generated one lands; the UI
      // renders a localized placeholder for empty titles, so no hardcoded
      // (language-specific) default is stored here.
      await this.store.saveSession({
        id: this.sessionId,
        title: "",
        metadata: {},
        projectId: this.context.projectId,
      });
    }

    const originalTurns = turns;
    let lastTurnId = turns.at(-2)?.id;

    if (mostRecentTurn?.type === "user") {
      await this.store.saveTurn({
        id: mostRecentTurn.id,
        sessionId: this.sessionId,
        type: "user",
        metadata: {},
        parentId: lastTurnId,
        content: mostRecentTurn,
        createdAt: new Date(),
      });
      lastTurnId = mostRecentTurn.id;
      await this.store.setActiveHead(this.sessionId, mostRecentTurn.id);
    }

    let controller!: ReadableStreamDefaultController<
      AgentStreamEvent<AgentToolSet>
    >;

    const stream = new ReadableStream<AgentStreamEvent<AgentToolSet>>({
      start(controllerArg) {
        controller = controllerArg;
      },
    });

    const safeError = (error: unknown) => {
      try {
        controller.error(error);
      } catch {
        // suppress errors when the stream has been closed
      }
    };

    const safeClose = () => {
      try {
        controller.close();
      } catch {
        // suppress errors when the stream has been closed
      }
    };

    const safeEnqueue = async (event: AgentStreamEvent<AgentToolSet>) => {
      try {
        await this.session.builder?.push(event);
        controller.enqueue(event);
      } catch {
        // suppress errors when the stream has been closed
      }
    };

    // Started, not awaited: the turn runs as a producer into `stream` while the
    // caller begins reading it. Awaiting here would run the whole turn to
    // completion first — the stream's queue never blocks, so every chunk would
    // sit buffered until the last one had already been produced.
    void (async () => {
      // Anything else that ends the turn — a throw out of `#runTurn`, a turn
      // that never produced a record — is a failure the session should show.
      let outcome: SessionEndStatus = "error";

      try {
        this.context.controller = {
          write: safeEnqueue,
          close: safeClose,
          error: safeError,
        };

        const turnId = await this.session.startTurn({
          turns: originalTurns,
        });

        const turn = await this.#runTurn({
          turnType: "assistant",
          title: session?.title,
          turnId,
          parentId: lastTurnId,
        });

        this.session.finishTurn({ turn });

        if (turn) {
          outcome = TURN_END_TO_SESSION_STATUS[turn.status];
        }

        this.context.controller?.close();
      } catch (error) {
        // A step reports its own ending through the turn's finish event; this
        // covers the rest of the turn — the store writes around it in
        // particular — which would otherwise reject unobserved and leave the
        // reader waiting for a stream that never ends.
        safeError(error);
      } finally {
        this.#running = false;
        await this.hooks.emit(
          "session_end",
          { sessionId: this.sessionId },
          this.extensionApi
        );
        onFinish(outcome);
      }
    })();

    return stream;
  }

  async generateSessionTitle(
    turnId: string,
    modelId: string,
    turn: AgentTurn<AgentToolSet>
  ) {
    try {
      const stepId = generateStepId();
      await this.context.controller?.write({
        type: "step.start",
        stepType: "session.title",
        model: modelId,
        turnId,
        id: stepId,
        createdAt: Date.now(),
      });

      const eventId = generateEventId();
      await this.context.controller?.write({
        id: eventId,
        type: "session.title.start",
        turnId,
        stepId,
        createdAt: Date.now(),
      });

      const step = await generateText({
        // The turn may be reusing a `context.modelId` that a later call has
        // already replaced, so the model is resolved from the argument.
        model: this.provider.chatModel(modelId),
        system: TITLE_PROMPT,
        prompt: this.getTextFromUserTurn(turn),
      });
      const title = step.text;

      await this.store.updateSessionById(this.sessionId, title);

      await this.context.controller?.write({
        id: eventId,
        type: "session.title.end",
        title,
        turnId,
        stepId,
        createdAt: Date.now(),
      });

      await this.context.controller?.write({
        id: stepId,
        turnId,
        type: "step.finish",
        createdAt: Date.now(),
        usage: step.usage,
        finishReason: step.finalStep.finishReason,
        rawFinishReason: step.finalStep.rawFinishReason,
        providerMetadata: step.finalStep.providerMetadata,
        status: "done",
        metadata: { performance: step.finalStep.performance },
      });

      await this.hooks.emit(
        "title_generated",
        { sessionId: this.sessionId, title },
        this.extensionApi
      );
      return title;
    } catch (error) {
      logger.warn("[agent] failed to generate session title", error);
    }
  }

  getTextFromUserTurn(turn: AgentTurn<AgentToolSet>): string {
    return turn.content
      .filter((step) => step.type === "user")
      .flatMap((step) => step.content.filter((e) => e.type === "text"))
      .map((part) => part.text)
      .join("");
  }

  toAgentTurns(turns: TurnModel[]): AgentTurn<AgentToolSet>[] {
    return turns.map((e) => e.content as AgentTurn<AgentToolSet>);
  }

  /**
   * Drives one assistant turn: repeated `#runStep` calls until the model stops
   * asking for tools, the step budget runs out, or a step is aborted or fails.
   *
   * The loop is driven by hand: each step issues its own `streamText` call, so
   * tool execution and approval handling stay outside the SDK's step loop and
   * every step sees the history the loop has built so far.
   *
   * Every step streams into the single UI message started by
   * {@link Agent.stream}; the finish is written once, by `#finishTurn`, because
   * only after the last step is "last" known.
   */
  async #runTurn(
    input: AgentTurnInput
  ): Promise<AgentTurn<AgentToolSet> | undefined> {
    const { turnId, title } = input;

    await this.context.controller?.write({
      type: "turn.start",
      id: turnId,
      turnType: "assistant",
      createdAt: Date.now(),
    });

    // Start title generation in the background (never awaited)
    if (!title) {
      const userTurn = this.session.turns.findLast((e) => e.type === "user");
      if (userTurn) {
        this.generateSessionTitle(turnId, this.context.modelId, userTurn);
      }
    }

    let status: AgentTurnStatus = { status: "done" };
    while (true) {
      const stepId = generateStepId();

      const outcome = await this.#runStep({
        ...input,
        stepId,
        stepType: "assistant",
      });

      if (!outcome.ok) {
        if (outcome.reason === "aborted") {
          status = { status: "aborted" };
        } else {
          status = { status: "error", error: outcome.error };
          status.error =
            status.error instanceof APICallError
              ? status.error.responseBody
              : getErrorMessage(status.error);
        }
        break;
      }

      this.session.finishStep(outcome.result);

      // The step asked the user for something, so the turn stops here rather
      // than with it: a step is what the loop continues from, and it cannot
      // continue past a call nobody has answered yet.
      if (outcome.result.awaitingApproval) {
        status = { status: "wait_review" };
        break;
      }

      if (!outcome.result.toolCallsResolved) {
        status = { status: "done" };
        break;
      }
    }

    await this.context.controller?.write({
      id: turnId,
      type: "turn.finish",
      createdAt: Date.now(),
      usage: this.session.usage,
      ...status,
    });

    // An aborted or failed step returns from `#runStep` before its
    // `step.finish`, so the step and its parts are still pending here; the
    // `turn.finish` above only clears the turn. Settling first keeps the copy
    // persisted below from carrying a `"streaming"` step forever. A `"done"`
    // turn is skipped so a still-streaming background title is not marked —
    // and so is one held for approval, whose step did reach its own end.
    if (status.status === "aborted" || status.status === "error") {
      this.session.builder?.settle(status.status);
    }

    // Every turn the stream changed is written back, not just the one that
    // finished: a stream that resumes a held call runs that call and reports
    // its result against the turn that asked for it — a turn that ended turns
    // ago — so writing back only the ending would leave the store holding the
    // unanswered state of a call that has since been answered.
    const changedTurns = this.session.builder?.changedTurns ?? [];

    for (const changed of changedTurns) {
      if (await this.store.existsTurn(changed.id)) {
        await this.store.updateTurn(changed.id, changed);
      } else {
        await this.store.saveTurn({
          id: changed.id,
          sessionId: this.sessionId,
          type: changed.type,
          metadata: {},
          content: changed,
          parentId: input.parentId ?? null,
          createdAt: new Date(),
        });
        await this.store.setActiveHead(this.sessionId, changed.id);
      }
    }

    // The turn this run drove, which is the one whose ending the session
    // reports — not simply the last one changed, because an earlier turn can be
    // touched after it.
    return changedTurns.findLast((changed) => changed.id === turnId);
  }

  /**
   * Runs one step: issues a single `streamText` call, pipes its chunks into the
   * open UI message, and folds the step's assistant and tool messages back into
   * the history so the next step sees them.
   *
   * Reports how the step ended rather than failing the stream: an aborted or
   * failed step is an ending the turn has to record, not a reason for the reader
   * to be left without one.
   */
  async #runStep(input: AgentStepInput): Promise<StepOutcome> {
    const { turnId, stepId } = input;
    const model = this.#getModel();
    const messages = this.session.modelMessages;

    await this.context.controller?.write({
      type: "step.start",
      stepType: "assistant",
      model: this.context.modelId,
      turnId,
      id: stepId,
      createdAt: Date.now(),
    });

    // 处理工具调用
    // A stream that carries approvals is a resumption: a previous turn's step
    // stopped with calls the user has now answered, and those calls run here,
    // before the model is asked anything, so the history the model is about to
    // read has their results in it.
    //
    // `tool:before` had its say when the calls were held — the answers are what
    // decides them now, which is why the approved ids are handed over rather
    // than the hooks being asked the same question twice.
    const { approvedToolApprovals, deniedToolApprovals } =
      collectToolApprovals<AgentToolSet>({ messages });

    if (approvedToolApprovals.length > 0 || deniedToolApprovals.length > 0) {
      const toolCallId =
        approvedToolApprovals[0]?.toolCall.toolCallId ||
        deniedToolApprovals[0]?.toolCall.toolCallId;
      const result = findToolPartByToolCallId(this.session.turns, toolCallId);
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
        await this.context.controller?.write({
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
          tools: this.tools,
          toolCalls: localApprovedToolApprovals.map(
            (toolApproval) => toolApproval.toolCall
          ),
          sessionId: this.sessionId,
          turnId: askedTurnId,
          stepId: askedStepId,
          messages,
          context: this.context,
          hooks: this.hooks,
          extensionApi: this.extensionApi,
          abortSignal: this.context.abortSignal,
          write: (event) =>
            this.context.controller?.write(event) ?? Promise.resolve(),
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

          await this.context.controller?.write({
            id: askedStepId,
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

      // 将调用完的工具结果保存
      const turn = this.session.turns.find((e) => e.id === askedTurnId);
      if (turn) {
        this.store.updateTurn(turn.id, turn);
      }
    }

    // 大模型调用
    let result;
    try {
      result = streamText<ToolSet, AgentRuntimeContext>({
        instructions: this.#instructions,
        model,
        // The SDK is given tools it can only describe: an `execute` in this set
        // would have it run the calls itself, out of `tool:before`'s reach.
        tools: stripToolExecution(this.tools),
        stopWhen: isStepCount(1),
        reasoning: this.context.modelEffort
          ? MODEL_EFFORT_TO_REASONING[this.context.modelEffort]
          : undefined,
        messages,
        abortSignal: this.context.abortSignal,
        include: {
          requestBody: true,
        },
      });
    } catch (error) {
      console.error(
        "agent#runStep streamText error.",
        this.context.abortSignal?.aborted,
        error
      );
      return this.context.abortSignal?.aborted
        ? { ok: false, reason: "aborted" }
        : { ok: false, reason: "error", error };
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
            this.context.abortSignal?.aborted,
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
          await this.context.controller?.write(event);
        }
      }
    } catch (error) {
      console.error(
        "agent#runStep reader error.",
        this.context.abortSignal?.aborted,
        streamError,
        error
      );
      // An abort surfaces here as the stream is torn down.
      return this.context.abortSignal?.aborted
        ? { ok: false, reason: "aborted" }
        : { ok: false, reason: "error", error: streamError ?? error };
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
        await this.context.controller?.write({
          id: stepId,
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

        return {
          ok: false,
          reason: "error",
          error: streamError ?? new Error("The model stream failed."),
        };
      }

      // The calls this loop owns. A provider-executed call arrives with its
      // result already attached, and one the model got wrong is the SDK's to
      // report: it emits a `tool.error` of its own for those, but no matching
      // tool message, which is why they can never count as answered below.
      const clientToolCalls = toolCalls.filter(
        (call) => call.providerExecuted !== true
      );

      const execution = await executeToolCalls({
        tools: this.tools,
        toolCalls: clientToolCalls.filter((call) => call.invalid !== true),
        sessionId: this.sessionId,
        turnId,
        stepId,
        messages,
        context: this.context,
        hooks: this.hooks,
        extensionApi: this.extensionApi,
        abortSignal: this.context.abortSignal,
        write: (event) =>
          this.context.controller?.write(event) ?? Promise.resolve(),
      });

      // A stop during the calls is the turn's ending, not a step's: the run
      // returns the way the reader loop's abort does, leaving the step pending
      // for `settle` to close. The events above have already been sent, so the
      // calls that did finish are on the reader's screen.
      if (this.context.abortSignal?.aborted) {
        return { ok: false, reason: "aborted" };
      }

      await this.context.controller?.write({
        id: stepId,
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
      messages.push(...responseMessages, ...execution.toolMessages);

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
            awaitingApproval: true,
          },
        };
      }

      // The continuation rule, read off our own outcomes now that the SDK no
      // longer reports them: keep going only while every client tool call came
      // back. A denial is an answer — the model is told the call was refused —
      // but a call the model got wrong is not, and continuing there would send
      // an assistant tool call with no matching tool message.
      const toolCallsResolved =
        clientToolCalls.length > 0 &&
        clientToolCalls.every((call) => call.invalid !== true) &&
        execution.outcomes.length === clientToolCalls.length;

      return {
        ok: true,
        result: {
          messages,
          usage,
          finishReason,
          rawFinishReason,
          toolCallsResolved,
          awaitingApproval: false,
        },
      };
    } catch (error) {
      console.error(
        "agent#runStep stream final error.",
        this.context.abortSignal?.aborted,
        streamError,
        error
      );
      // The stream can fail before any step is recorded, which rejects the two
      // promises above instead of ending the reader loop.
      return this.context.abortSignal?.aborted
        ? { ok: false, reason: "aborted" }
        : { ok: false, reason: "error", error: streamError ?? error };
    }
  }
}
