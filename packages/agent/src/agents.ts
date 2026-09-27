import { DevToolsTelemetry } from "@ai-sdk/devtools";
import { AgentTurnBuilder } from "@workspace/agent-client";
import type {
  AgentRuntimeContext,
  AgentStep,
  AgentStreamEvent,
  AgentTurn,
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
  ToolSet,
} from "ai";
import { addLanguageModelUsage } from "ai/internal";

import { compactMessages, shouldCompact } from "./compaction/compaction";
import type { AgentContext } from "./context";
import { HooksManager } from "./hooks-manager";
import type { ExtensionAPI } from "./hooks-manager";
import { AgentSession } from "./session";
import type { AgentStore } from "./storage";
import type { AgentToolSet } from "./types";
import { convertAgentTurnToModalMessage } from "./utils/convert-to-model-message";
import { generateMessageId, generatePartId } from "./utils/id-util";
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
  model: LanguageModel;
  session?: AgentSession;
  tools?: ToolSet;
  store: AgentStore;
  systemPrompt?: string;
  effort?: ModelEffort;
  context: AgentContext;
  hooks?: HooksManager;
  extensionApi?: ExtensionAPI;
};

export type AgentStreamOptions = {
  model: LanguageModel;
  modelId: string;
  abortSignal?: AbortSignal;
  messages: AgentTurn<AgentToolSet>[];
};

interface UIMessageStreamWriter {
  /**
   * Appends a data stream part to the stream.
   */
  write(
    data: AgentStreamEvent<AgentToolSet>,
    builder?: AgentTurnBuilder<AgentToolSet>
  ): Promise<void>;
  close(): void;
  /**
   * Error handler that is used by the data stream writer.
   * This is intended for forwarding when merging streams
   * to prevent duplicated error masking.
   */
  error: (error: unknown) => void;
}

type AgentTurnInput = {
  readonly title?: string;
  readonly turnType: AgentTurn<AgentToolSet>["type"];
  readonly turnId: string;
  readonly prevTurnId?: string;
  readonly modelId: string;
  readonly abortSignal?: AbortSignal;
  readonly compactionConfig: CompactionConfig;
  readonly messages: ModelMessage[];
  readonly turns: AgentTurn<AgentToolSet>[];
  readonly model: LanguageModel;
  readonly writer: UIMessageStreamWriter;
};

type AgentStepInput = AgentTurnInput & {
  readonly stepId: string;
  readonly stepType: AgentStep<AgentToolSet>["type"];
  readonly builder: AgentTurnBuilder<AgentToolSet>;
};

/** What one completed step of the model loop reported back. */
type AgentStepResult = {
  /** The step's history, including its own assistant and tool messages. */
  readonly messages: ModelMessage[];
  /** This step's usage alone; {@link Agent.runTurn} totals it across steps. */
  readonly usage: LanguageModelUsage;
  readonly finishReason: FinishReason;
  readonly rawFinishReason: string | undefined;
  /**
   * Whether every client tool call this step issued came back with a result —
   * the loop's continuation rule.
   */
  readonly toolCallsResolved: boolean;
};

export class Agent {
  name: string;
  sessionId: string;
  model: LanguageModel;
  systemPrompt?: string;
  session: AgentSession;
  tools: ToolSet;
  store: AgentStore;
  context: AgentContext;
  effort?: ModelEffort;
  hooks: HooksManager;
  extensionApi: ExtensionAPI;

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.sessionId = options.sessionId;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.session = options.session ?? new AgentSession({ messages: [] });
    this.tools = options.tools ?? {};
    this.store = options.store;
    this.context = options.context;
    this.effort = options.effort;
    this.hooks = options.hooks ?? new HooksManager();
    this.extensionApi = options.extensionApi ?? {};
  }

  async stream({ messages, model, modelId, abortSignal }: AgentStreamOptions) {
    const mostRecentTurn = messages.at(-1);

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
        metadata: "",
      });
    }

    const previousMessages = await this.store.getBranchTurns(this.sessionId);
    const previousTurns = this.toAgentTurns(previousMessages);
    const originalTurns = [...previousTurns, mostRecentTurn];
    const modelMessages =
      await convertAgentTurnToModalMessage<AgentToolSet>(originalTurns);

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

    // Downstream can stop reading at any moment — the client aborts, the window
    // closes — and `cancel` is the only notification the stream gets. It drives
    // a controller of its own, merged with the caller's signal, so either one
    // stops the turn and the model call it is waiting on.
    const turnAbort = new AbortController();
    const turnSignal = abortSignal
      ? AbortSignal.any([abortSignal, turnAbort.signal])
      : turnAbort.signal;

    const stream = new ReadableStream<AgentStreamEvent<AgentToolSet>>({
      start(controllerArg) {
        controller = controllerArg;
      },
      cancel(reason) {
        turnAbort.abort(reason);
      },
    });

    function safeError(error: unknown) {
      try {
        controller.error(error);
      } catch {
        // suppress errors when the stream has been closed
      }
    }

    function safeClose() {
      try {
        controller.close();
      } catch {
        // suppress errors when the stream has been closed
      }
    }

    async function safeEnqueue(
      event: AgentStreamEvent<AgentToolSet>,
      builder?: AgentTurnBuilder<AgentToolSet>
    ) {
      try {
        await builder?.push(event);
        controller.enqueue(event);
      } catch {
        // suppress errors when the stream has been closed
      }
    }

    const compactionConfig: CompactionConfig = {
      recentWindowSize: 10,
      threshold: 100_000,
      thresholdPercent: 0.9,
      lastKnownInputTokens:
        originalTurns.findLast((e) => e.usage)?.usage?.inputTokens ?? 0,
      lastKnownPromptMessageCount: originalTurns.length,
    };

    const turnId = generateMessageId();

    // Started, not awaited: the turn runs as a producer into `stream` while the
    // caller begins reading it. Awaiting here would run the whole turn to
    // completion first — the stream's queue never blocks, so every chunk would
    // sit buffered until the last one had already been produced.
    void (async () => {
      try {
        await this.runTurn({
          turnType: "assistant",
          writer: {
            write: safeEnqueue,
            close: safeClose,
            error: safeError,
          },
          title: session?.title,
          turnId,
          modelId,
          model,
          turns: originalTurns,
          abortSignal: turnSignal,
          compactionConfig,
          messages: modelMessages,
        });
      } catch (error) {
        // `runStep` reports its own failures through the writer; this covers
        // the rest of the turn — the store writes around it in particular —
        // which would otherwise reject unobserved and leave the reader waiting
        // for a stream that never ends.
        safeError(error);
      } finally {
        await this.hooks.emit(
          "session_end",
          { sessionId: this.sessionId },
          this.extensionApi
        );
      }
    })();

    return stream;
  }

  async generateSessionTitle(
    turnId: string,
    modelId: string,
    builder: AgentTurnBuilder<AgentToolSet>,
    turn: AgentTurn<AgentToolSet>,
    writer: UIMessageStreamWriter
  ) {
    try {
      const stepId = generateMessageId();
      await writer.write(
        {
          type: "step.start",
          stepType: "session.title",
          model: modelId,
          turnId,
          id: stepId,
          createdAt: Date.now(),
        },
        builder
      );

      const eventId = generateMessageId();
      await writer.write(
        {
          id: eventId,
          type: "session.title.start",
          turnId,
          stepId,
          createdAt: Date.now(),
        },
        builder
      );

      const step = await generateText({
        model: this.model,
        system: TITLE_PROMPT,
        prompt: this.getTextFromUserTurn(turn),
      });
      const title = step.text;

      await this.store.updateSessionById(this.sessionId, title);

      await writer.write(
        {
          id: eventId,
          type: "session.title.end",
          title,
          turnId,
          stepId,
          createdAt: Date.now(),
        },
        builder
      );

      await writer.write(
        {
          id: stepId,
          turnId,
          type: "step.finish",
          createdAt: Date.now(),
          usage: step.usage,
          performance: step.finalStep.performance,
          finishReason: step.finalStep.finishReason,
          rawFinishReason: step.finalStep.rawFinishReason,
          providerMetadata: step.finalStep.providerMetadata,
        },
        builder
      );

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

  toAgentTurns(messages: TurnModel[]): AgentTurn<AgentToolSet>[] {
    return messages.map((e) => e.content as AgentTurn<AgentToolSet>);
  }

  /**
   * Drives one assistant turn: repeated {@link Agent.runStep} calls until the
   * model stops asking for tools, the step budget runs out, or a step is
   * aborted or fails.
   *
   * The loop is driven by hand so compaction can run before every model call.
   * `ToolLoopAgent` invokes `prepareCall` once per stream — its step loop lives
   * inside a single `streamText` call — so the compaction check only ever saw
   * the first prompt, and the token count each step reported was never read.
   * One `streamText` call per step keeps the estimate in sync with the prompt
   * the model is about to receive.
   *
   * Every step streams into the single UI message started by
   * {@link Agent.stream}; the `finish` chunk is written here, once, after the
   * last step, because only then is "last" known.
   */
  private async runTurn(
    input: AgentTurnInput
  ): Promise<AgentTurn<AgentToolSet> | undefined> {
    const { abortSignal, writer, turnId, turns, title, modelId } = input;
    let { messages } = input;

    const builder = new AgentTurnBuilder<AgentToolSet>({ turns });

    await writer.write(
      {
        type: "turn.start",
        id: turnId,
        turnType: "assistant",
        createdAt: Date.now(),
      },
      builder
    );

    // Start title generation in the background (never awaited)
    if (!title) {
      const userTurn = turns.findLast((e) => e.type === "user");
      if (userTurn) {
        this.generateSessionTitle(turnId, modelId, builder, userTurn, writer);
      }
    }

    // Each step reports only its own usage; the persisted metadata has to
    // total the turn, which the SDK did for us when one call drove it all.
    let totalUsage: LanguageModelUsage | undefined;

    for (let step = 0; step < MAX_STEPS; step += 1) {
      // A doomed call would emit a second `abort` chunk and reject its result
      // promises; stopping here keeps it to one abort per turn.
      if (abortSignal?.aborted) {
        return;
      }

      // The step reads the history `messages` currently holds, which compaction
      // or the previous step may have replaced.
      const stepId = generateMessageId();
      const stepResult = await this.runStep({
        ...input,
        messages,
        stepId,
        stepType: "assistant",
        builder,
      });

      // Aborted or the model call failed: the stream already delivered its
      // `abort`/`error` chunk, so the turn ends without a `finish` chunk.
      if (stepResult === undefined) {
        return;
      }

      ({ messages } = stepResult);
      totalUsage =
        totalUsage === undefined
          ? stepResult.usage
          : addLanguageModelUsage(totalUsage, stepResult.usage);

      if (!stepResult.toolCallsResolved) {
        break;
      }
    }

    await writer.write(
      {
        id: turnId,
        type: "turn.finish",
        createdAt: Date.now(),
        usage: totalUsage,
      },
      builder
    );

    writer.close();

    const turn = builder.completedTurns.at(-1);
    if (turn) {
      const existingTurn = await this.store.existsTurn(turn.id);
      if (existingTurn) {
        await this.store.updateTurn(turn.id, turn, {});
      } else {
        const lastTurnId = turns.at(-2)?.id;
        await this.store.saveTurn({
          id: turn.id,
          sessionId: this.sessionId,
          type: turn.type,
          metadata: {},
          content: turn,
          parentId: lastTurnId,
          createdAt: new Date(),
        });
        await this.store.setActiveHead(this.sessionId, turn.id);
      }
    }
  }

  /**
   * Runs one step: compacts the history if it has outgrown the threshold,
   * issues a single `streamText` call, pipes its chunks into the open UI
   * message, and folds the step's assistant and tool messages back into that
   * history so the next step sees them.
   *
   * Returns `undefined` when the step was aborted or the model call failed.
   * In both cases the stream has already emitted its `abort`/`error` chunk,
   * and the turn has to end without a `finish` chunk.
   */
  private async runStep(
    input: AgentStepInput
  ): Promise<AgentStepResult | undefined> {
    const {
      abortSignal,
      compactionConfig,
      model,
      modelId,
      turnId,
      stepId,
      writer,
      builder,
    } = input;

    const compactionStepId = generateMessageId();
    const compaction = await this.maybeCompact({
      config: compactionConfig,
      messages: input.messages,
      abortSignal,
      model,
      onBeforeCompact: () =>
        this.announceCompactionStart(turnId, compactionStepId, builder, writer),
      onAfterCompact: (params) =>
        this.announceCompactionEnd(
          turnId,
          compactionStepId,
          builder,
          writer,
          params
        ),
    });
    const { messages } = compaction;
    compactionConfig.lastKnownPromptMessageCount = messages.length;

    await writer.write(
      {
        type: "step.start",
        stepType: "assistant",
        model: modelId,
        turnId,
        id: stepId,
        createdAt: Date.now(),
      },
      builder
    );

    const result = streamText<ToolSet, AgentRuntimeContext>({
      instructions: this.systemPrompt,
      model,
      tools: this.tools,
      stopWhen: isStepCount(1),
      reasoning: this.effort
        ? MODEL_EFFORT_TO_REASONING[this.effort]
        : undefined,
      messages,
      abortSignal,
    });

    const reader = result.stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        const event = toAgentEvent<AgentToolSet>(turnId, stepId, value as any);
        if (event) {
          await writer.write(event, builder);
        }
      }
    } catch (error) {
      writer.error(error);
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

      compactionConfig.lastKnownInputTokens = step.usage.inputTokens;

      await writer.write(
        {
          id: stepId,
          turnId,
          type: "step.finish",
          createdAt: Date.now(),
          usage: step.usage,
          performance: step.performance,
          finishReason: step.finishReason,
          rawFinishReason: step.rawFinishReason,
          providerMetadata: step.providerMetadata,
        },
        builder
      );

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
        messages,
        usage,
        finishReason,
        rawFinishReason,
        toolCallsResolved:
          clientToolCalls.length > 0 &&
          clientToolCalls.length === clientToolResults.length,
      };
    } catch (error) {
      console.error(error);
      writer.error(error);
      return undefined;
    }
  }

  private async announceCompactionStart(
    turnId: string,
    stepId: string,
    builder: AgentTurnBuilder<AgentToolSet>,
    writer: UIMessageStreamWriter
  ): Promise<void> {
    const createdAt = Date.now();
    await writer.write(
      {
        turnId,
        stepId,
        id: generatePartId(),
        type: "compaction.start",
        createdAt,
      },
      builder
    );
    await this.hooks.emit(
      "compaction:start",
      { sessionId: this.sessionId, createdAt },
      this.extensionApi
    );
  }

  private async announceCompactionEnd(
    turnId: string,
    stepId: string,
    builder: AgentTurnBuilder<AgentToolSet>,
    writer: UIMessageStreamWriter,
    params: { compacted: boolean; messages: ModelMessage[] }
  ): Promise<void> {
    const createdAt = Date.now();
    await writer.write(
      {
        turnId,
        stepId,
        id: generatePartId(),
        type: "compaction.end",
        compacted: params.compacted,
        messages: params.messages,
        createdAt,
      },
      builder
    );
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
   * Called by {@link Agent.runStep} before every model call, so the compacted
   * messages become the history the next step — and every step after it —
   * sends to the model. Gating on `shouldCompact` is what keeps that from
   * re-summarizing the same conversation on every step.
   */
  private async maybeCompact(input: {
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
