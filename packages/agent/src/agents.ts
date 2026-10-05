import { DevToolsTelemetry } from "@ai-sdk/devtools";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import type {
  AgentRuntimeContext,
  AgentStep,
  AgentStreamEvent,
  AgentTurn,
  AgentTurnStatus,
  CompactionConfig,
} from "@workspace/agent-client";
import type { TurnModel } from "@workspace/db";
import { ModelEffort } from "@workspace/shared/constants";
import { logger } from "@workspace/shared/logger";
import { generateText, isStepCount, registerTelemetry, streamText } from "ai";
import type {
  FinishReason,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  TextStreamPart,
  ToolSet,
} from "ai";

import type { AgentContext } from "./agent-context";
import { AgentSession } from "./agent-session";
import { compactMessages, shouldCompact } from "./compaction/compaction";
import { HooksManager } from "./hooks-manager";
import type { ExtensionAPI } from "./hooks-manager";
import type { AgentStore } from "./storage";
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

/**
 * Step budget for one assistant turn. The manual loop issues one `streamText`
 * call per step, so the budget lives here instead of in the SDK's `stopWhen`.
 */
const MAX_STEPS = 100;

export type AgentOptions = {
  name: string;
  sessionId: string;
  session?: AgentSession;
  tools?: ToolSet;
  store: AgentStore;
  systemPrompt?: string;
  context: AgentContext;
  hooks?: HooksManager;
  extensionApi?: ExtensionAPI;
  apiKey: string;
  apiUrl: string;
  providerId: string;
  modelId: string;
  modelEffort?: ModelEffort;
};

export type AgentStreamOptions = {
  modelId: string;
  turns: AgentTurn<AgentToolSet>[];
  onFinish: () => Promise<void>;
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
};

/** What one call of {@link Agent.#runSteps} reported back to the turn loop. */
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
  extensionApi: ExtensionAPI;

  apiKey: string;
  apiUrl: string;
  providerId: string;
  provider: OpenAICompatibleProvider;

  context: AgentContext;
  session: AgentSession;

  readonly #abortController = new AbortController();

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
    // The turn's abort scope belongs to the agent running it: `abort()` is the
    // only way in, and every step reads the signal back off the context.
    this.context.abortSignal = this.#abortController.signal;
    this.session = options.session ?? new AgentSession({ turns: [] });
    this.provider = createOpenAICompatible({
      apiKey: this.apiKey,
      baseURL: this.apiUrl,
      name: this.providerId,
    });
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

  async stream({ turns, modelId, onFinish }: AgentStreamOptions) {
    this.context.modelId = modelId;
    this.session.turns = turns;

    const mostRecentTurn = turns.at(-1);

    if (!mostRecentTurn) {
      throw new Error("no message.");
    }

    await this.hooks.emit(
      "session_start",
      {
        sessionId: this.sessionId,
        name: this.name,
        workdir: this.context.workdir,
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
      });
    }

    const previousMessages = await this.store.getBranchTurns(this.sessionId);
    const previousTurns = this.toAgentTurns(previousMessages);
    const originalTurns = [...previousTurns, mostRecentTurn];

    let lastTurnId = previousMessages.at(-1)?.id;

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

        this.context.controller?.close();
      } catch (error) {
        // A step reports its own ending through the turn's finish event; this
        // covers the rest of the turn — the store writes around it in
        // particular — which would otherwise reject unobserved and leave the
        // reader waiting for a stream that never ends.
        safeError(error);
      } finally {
        await this.hooks.emit(
          "session_end",
          { sessionId: this.sessionId },
          this.extensionApi
        );
        onFinish();
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
        performance: step.finalStep.performance,
        finishReason: step.finalStep.finishReason,
        rawFinishReason: step.finalStep.rawFinishReason,
        providerMetadata: step.finalStep.providerMetadata,
        status: "done",
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
   * Drives one assistant turn: repeated `#runSteps` calls until the model stops
   * asking for tools, the step budget runs out, or a step is aborted or fails.
   *
   * The loop is driven by hand so compaction can run before every model call.
   * `ToolLoopAgent` invokes `prepareCall` once per stream — its step loop lives
   * inside a single `streamText` call — so the compaction check only ever saw
   * the first prompt, and the token count each step reported was never read.
   * One `streamText` call per step keeps the estimate in sync with the prompt
   * the model is about to receive.
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

    // [TODO] remove hardcode
    let status: AgentTurnStatus = { status: "done" };
    for (let step = 0; step < MAX_STEPS; step += 1) {
      // The step reads the history `messages` currently holds, which compaction
      // or the previous step may have replaced.
      const stepId = generateStepId();

      const outcome = await this.#runSteps({
        ...input,
        stepId,
        stepType: "assistant",
      });

      if (!outcome.ok) {
        status =
          outcome.reason === "aborted"
            ? { status: "aborted" }
            : { status: "error", error: outcome.error };
        break;
      }

      this.session.finishStep(outcome.result);

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

    // An aborted or failed step returns from `#runSteps` before its
    // `step.finish`, so the step and its parts are still pending here; the
    // `turn.finish` above only clears the turn. Settling first keeps the copy
    // persisted below from carrying a `"streaming"` step forever. A `"done"`
    // turn is skipped so a still-streaming background title is not marked.
    if (status.status !== "done") {
      this.session.builder?.settle(status.status);
    }

    const turn = this.session.builder?.completedTurns.at(-1);

    if (turn) {
      if (await this.store.existsTurn(turn.id)) {
        await this.store.updateTurn(turn.id, turn, {});
      } else {
        await this.store.saveTurn({
          id: turn.id,
          sessionId: this.sessionId,
          type: turn.type,
          metadata: {},
          content: turn,
          parentId: input.parentId ?? null,
          createdAt: new Date(),
        });
        await this.store.setActiveHead(this.sessionId, turn.id);
      }
    }

    return turn;
  }

  /**
   * Runs one step: compacts the history if it has outgrown the threshold,
   * issues a single `streamText` call, pipes its chunks into the open UI
   * message, and folds the step's assistant and tool messages back into that
   * history so the next step sees them.
   *
   * Reports how the step ended rather than failing the stream: an aborted or
   * failed step is an ending the turn has to record, not a reason for the reader
   * to be left without one.
   */
  async #runSteps(input: AgentStepInput): Promise<StepOutcome> {
    const { turnId, stepId } = input;
    const model = this.#getModel();

    this.context.compactionConfig.lastKnownInputTokens =
      this.session.lastKnownInputTokens;
    this.context.compactionConfig.lastKnownPromptMessageCount =
      this.session.modelMessages.length;

    const compactionStepId = generateStepId();
    let messages: ModelMessage[];
    try {
      const compaction = await this.#maybeCompact({
        config: this.context.compactionConfig,
        messages: this.session.modelMessages,
        abortSignal: this.context.abortSignal,
        model,
        onBeforeCompact: () =>
          this.#announceCompactionStart(turnId, compactionStepId),
        onAfterCompact: (params) =>
          this.#announceCompactionEnd(turnId, compactionStepId, params),
      });
      ({ messages } = compaction);
    } catch (error) {
      console.error(
        "agent#runSteps compaction error.",
        this.context.abortSignal?.aborted,
        error
      );
      // Compaction is a model call the step makes before its own, so a failure
      // or an abort there is how the step ended, not a reason to fail the
      // stream. Left to throw, it would skip `turn.finish` and the store write
      // below and the turn would disappear instead of showing as aborted.
      return this.context.abortSignal?.aborted
        ? { ok: false, reason: "aborted" }
        : { ok: false, reason: "error", error };
    }

    await this.context.controller?.write({
      type: "step.start",
      stepType: "assistant",
      model: this.context.modelId,
      turnId,
      id: stepId,
      createdAt: Date.now(),
    });

    let result;
    try {
      result = streamText<ToolSet, AgentRuntimeContext>({
        instructions: this.systemPrompt,
        model,
        tools: this.tools,
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
        "agent#runSteps streamText error.",
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
            "[agent] model stream failed4",
            this.context.abortSignal?.aborted,
            value.error
          );
        } else if (value.type === "abort") {
          console.error(
            "[agent] model stream aborted",
            this.context.abortSignal?.aborted,
            value.reason
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
        "agent#runSteps reader error.",
        this.context.abortSignal?.aborted,
        error
      );
      // An abort surfaces here as the stream is torn down.
      return this.context.abortSignal?.aborted
        ? { ok: false, reason: "aborted" }
        : { ok: false, reason: "error", error };
    } finally {
      reader.releaseLock();
    }

    try {
      const [step, responseMessages] = await Promise.all([
        result.finalStep,
        result.responseMessages,
      ]);
      const { finishReason, rawFinishReason, usage, toolCalls, toolResults } =
        step;

      await this.context.controller?.write({
        id: stepId,
        turnId,
        type: "step.finish",
        createdAt: Date.now(),
        usage: step.usage,
        performance: step.performance,
        finishReason: step.finishReason,
        rawFinishReason: step.rawFinishReason,
        providerMetadata: step.providerMetadata,
        status: "done",
      });

      // The step did end, hence the event above, but a step the model ended with
      // `error` cannot be reported as a whole turn.
      if (finishReason === "error") {
        return {
          ok: false,
          reason: "error",
          error: streamError ?? new Error("The model stream failed."),
        };
      }

      // Exactly the messages the SDK feeds its own next step: the assistant
      // message for this step plus a tool message for whatever executed.
      messages.push(...responseMessages);

      // The SDK's own continuation rule: keep going only while every client
      // tool call came back. A tool without `execute`, or a denied approval,
      // still finishes with `tool-calls`; continuing there would send an
      // assistant tool call with no matching tool message.
      const clientToolCalls = toolCalls.filter(
        (call) => call.providerExecuted !== true
      );
      const clientToolResults = toolResults.filter(
        (toolResult) => toolResult.providerExecuted !== true
      );

      return {
        ok: true,
        result: {
          messages,
          usage,
          finishReason,
          rawFinishReason,
          toolCallsResolved:
            clientToolCalls.length > 0 &&
            clientToolCalls.length === clientToolResults.length,
        },
      };
    } catch (error) {
      console.error(
        "agent#runSteps stream final error.",
        this.context.abortSignal?.aborted,
        error
      );
      // The stream can fail before any step is recorded, which rejects the two
      // promises above instead of ending the reader loop.
      return this.context.abortSignal?.aborted
        ? { ok: false, reason: "aborted" }
        : { ok: false, reason: "error", error };
    }
  }

  async #announceCompactionStart(
    turnId: string,
    stepId: string
  ): Promise<void> {
    const createdAt = Date.now();
    // await this.context.controller?.write({
    //   type: "step.start",
    //   stepType: "compaction",
    //   model: modelId,
    //   turnId,
    //   id: stepId,
    //   createdAt: Date.now(),
    // });
    await this.context.controller?.write({
      turnId,
      stepId,
      id: generateEventId(),
      type: "compaction.start",
      createdAt,
    });
    await this.hooks.emit(
      "compaction:start",
      { sessionId: this.sessionId, createdAt },
      this.extensionApi
    );
  }

  async #announceCompactionEnd(
    turnId: string,
    stepId: string,
    params: { compacted: boolean; messages: ModelMessage[] }
  ): Promise<void> {
    const createdAt = Date.now();
    await this.context.controller?.write({
      turnId,
      stepId,
      id: generateEventId(),
      type: "compaction.end",
      compacted: params.compacted,
      messages: params.messages,
      createdAt,
    });
    // await this.context.controller?.write({
    //   id: stepId,
    //   turnId,
    //   type: "step.finish",
    //   createdAt: Date.now(),
    //   usage: step.usage,
    //   performance: step.performance,
    //   finishReason: step.finishReason,
    //   rawFinishReason: step.rawFinishReason,
    //   providerMetadata: step.providerMetadata,
    //   status: "done",
    // });
    await this.hooks.emit(
      "compaction:end",
      {
        sessionId: this.sessionId,
        compacted: params.compacted,
        messages: params.messages,
        createdAt,
      },
      this.extensionApi
    );
  }

  /**
   * Runs the compaction pipeline once if the session's input-token estimate
   * is over the configured threshold. Mutates neither input; returns the new
   * messages array and (possibly updated) session.
   *
   * Called by `#runSteps` before every model call, so the compacted
   * messages become the history the next step — and every step after it —
   * sends to the model. Gating on `shouldCompact` is what keeps that from
   * re-summarizing the same conversation on every step.
   */
  async #maybeCompact(input: {
    readonly force?: boolean;
    readonly config: CompactionConfig;
    readonly abortSignal?: AbortSignal;
    readonly messages: ModelMessage[];
    readonly model: LanguageModel;
    readonly onBeforeCompact?: () => void | Promise<void>;
    readonly onAfterCompact?: (params: {
      compacted: boolean;
      messages: ModelMessage[];
    }) => void | Promise<void>;
  }): Promise<{
    readonly compacted: boolean;
    readonly messages: ModelMessage[];
  }> {
    let { messages } = input;
    const { config, abortSignal, model, onBeforeCompact, onAfterCompact } =
      input;

    if (input.force !== true && !shouldCompact(messages, config)) {
      return { compacted: false, messages };
    }

    await onBeforeCompact?.();

    messages = await compactMessages(
      messages,
      model,
      config,
      abortSignal,
      true
    );

    const result = { compacted: true, messages };

    await onAfterCompact?.(result);

    return result;
  }
}
