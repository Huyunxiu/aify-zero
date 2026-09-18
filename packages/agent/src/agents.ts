import { DevToolsTelemetry } from "@ai-sdk/devtools";
import type { MessageModel } from "@workspace/db";
import { ModelEffort } from "@workspace/shared/constants";
import { getErrorMessage } from "@workspace/shared/errors";
import {
  convertToModelMessages,
  createUIMessageStream,
  generateText,
  isStepCount,
  registerTelemetry,
  streamText,
  toUIMessageStream,
} from "ai";
import type {
  FinishReason,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  ToolSet,
  UIMessagePart,
  UIMessageStreamWriter,
} from "ai";
import { addLanguageModelUsage } from "ai/internal";

import { compactMessages, shouldCompact } from "./compaction/compaction";
import type { AgentContext } from "./context";
import { HooksManager } from "./hooks-manager";
import type { ExtensionAPI } from "./hooks-manager";
import { AgentSession } from "./session";
import type { AgentStore } from "./storage";
import { SQLiteStore } from "./storage/sqlite-store";
import type {
  AgentRuntimeContext,
  AgentUIDataParts,
  AgentUIMessage,
  AgentUITools,
  CompactionConfig,
} from "./types";
import { generateMessageId, generatePartId } from "./utils/id-util";

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
  systemPrompt?: string;
  effort?: ModelEffort;
  context: AgentContext;
  hooks?: HooksManager;
  extensionApi?: ExtensionAPI;
};

export type AgentStreamOptions = {
  model: LanguageModel;
  abortSignal?: AbortSignal;
  messages: AgentUIMessage[];
};

/** What one step of the model loop needs to run. */
type AgentStepInput = {
  readonly abortSignal?: AbortSignal;
  readonly compactionConfig: CompactionConfig;
  readonly messages: ModelMessage[];
  readonly model: LanguageModel;
  readonly writer: UIMessageStreamWriter<AgentUIMessage>;
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
    this.store = new SQLiteStore();
    this.context = options.context;
    this.effort = options.effort;
    this.hooks = options.hooks ?? new HooksManager();
    this.extensionApi = options.extensionApi ?? {};
  }

  async stream({ messages, model, abortSignal }: AgentStreamOptions) {
    let titlePromise: Promise<string> | null = null;

    const mostRecentMessage = messages.at(-1);

    if (!mostRecentMessage) {
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

    // Start title generation in parallel (don't await) when this is the
    // session's first stream (the row above was just created). Once the
    // generated title lands, the row is updated and the UI is notified via
    // the data-session:title event; until then the title stays empty and the
    // UI shows its localized placeholder.
    if (!session) {
      titlePromise = this.generateChatTitle(mostRecentMessage);
    }

    const previousMessages = await this.store.getBranchMessages(this.sessionId);
    const previousUIMessages = this.toAgentUIMessage(previousMessages);
    const originalMessages = [...previousUIMessages, mostRecentMessage];
    const modelMessages = await this.convertToModalMessage(originalMessages);

    let lastMessageId = previousMessages.at(-1)?.id;

    if (mostRecentMessage?.role === "user") {
      await this.store.saveMessage({
        id: mostRecentMessage.id,
        sessionId: this.sessionId,
        role: "user",
        metadata: "{}",
        parentId: lastMessageId,
        content: mostRecentMessage.parts,
        createdAt: new Date(),
      });
      lastMessageId = mostRecentMessage.id;
      await this.store.setActiveHead(this.sessionId, lastMessageId);
    }

    return createUIMessageStream<AgentUIMessage>({
      execute: async ({ writer }) => {
        writer.write({
          type: "start",
          messageId: generateMessageId(),
          messageMetadata: {
            createdAt: Date.now(),
          },
        });

        // Handle title generation in parallel
        titlePromise?.then(async (title) => {
          await this.store.updateSessionById(this.sessionId, title);
          writer.write({
            type: "data-session:title",
            data: {
              title,
              createdAt: Date.now(),
            },
            transient: true,
          });
          await this.hooks.emit(
            "title_generated",
            { sessionId: this.sessionId, title },
            this.extensionApi
          );
        });

        const compactionConfig: CompactionConfig = {
          recentWindowSize: 10,
          threshold: 100_000,
          thresholdPercent: 0.9,
          lastKnownInputTokens:
            originalMessages.findLast((m) => m.role === "assistant")?.metadata
              ?.usage?.inputTokens ?? 0,
          lastKnownPromptMessageCount: originalMessages.length,
        };

        await this.runTurn({
          writer,
          model,
          abortSignal,
          compactionConfig,
          messages: modelMessages,
        });
      },
      originalMessages,
      onEnd: async (data) => {
        const finishedMsg = data.responseMessage;
        const existingMsg = await this.store.existsMessages(finishedMsg.id);
        if (existingMsg) {
          await this.store.updateMessage(
            finishedMsg.id,
            finishedMsg.parts,
            finishedMsg.metadata
          );
        } else {
          await this.store.saveMessage({
            id: finishedMsg.id,
            sessionId: this.sessionId,
            role: finishedMsg.role,
            metadata: finishedMsg.metadata,
            content: finishedMsg.parts,
            parentId: lastMessageId,
            createdAt: new Date(),
          });
          lastMessageId = finishedMsg.id;
          await this.store.setActiveHead(this.sessionId, lastMessageId);
        }

        await this.hooks.emit(
          "session_end",
          { sessionId: this.sessionId, messageId: finishedMsg.id },
          this.extensionApi
        );
      },
      onError(error) {
        // The returned string becomes `useChat.error.message` on the client,
        // so it carries the encoded code the UI resolves a message from.
        console.error("Agent#stream error.", error);
        return getErrorMessage(error);
      },
    });
  }

  async convertToModalMessage(
    originalMessages: AgentUIMessage[]
  ): Promise<ModelMessage[]> {
    let messages: AgentUIMessage[] = [];

    const compactedMessage: ModelMessage[] = [];
    for (const m of originalMessages) {
      let newParts: UIMessagePart<AgentUIDataParts, AgentUITools>[] = [];
      const newMessage: AgentUIMessage = { ...m, parts: newParts };
      for (const p of m.parts) {
        if (
          p.type === "data-compaction:end" &&
          p.data.compacted &&
          p.data.messages.length
        ) {
          compactedMessage.push(...p.data.messages);
          messages = [];
          newParts = [];
          newMessage.parts = newParts;
        }

        newParts.push(p);
      }
      messages.push(newMessage);
    }

    const m2 = await convertToModelMessages<AgentUIMessage>(messages);

    return [...compactedMessage, ...m2];
  }

  async generateChatTitle(message: AgentUIMessage) {
    const { text: title } = await generateText({
      model: this.model,
      system: TITLE_PROMPT,
      prompt: this.getTextFromMessage(message),
    });

    return title;
  }

  getTextFromMessage(message: AgentUIMessage): string {
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  toAgentUIMessage(messages: MessageModel[]): AgentUIMessage[] {
    return messages.map(
      (e) =>
        ({
          id: e.id,
          role: e.role,
          metadata: e.metadata,
          parts: e.content,
        }) as AgentUIMessage
    );
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
  private async runTurn(input: AgentStepInput): Promise<void> {
    const { abortSignal, writer } = input;
    let { messages } = input;

    // Set only once a step has completed. Aborting or failing a step leaves it
    // unset, which suppresses the `finish` chunk — `streamText` emits an
    // `abort`/`error` part instead of `finish` in exactly those cases.
    let lastStep:
      | { finishReason: FinishReason; rawFinishReason: string | undefined }
      | undefined;
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
      const stepResult = await this.runStep({ ...input, messages });

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
      lastStep = stepResult;

      if (!stepResult.toolCallsResolved) {
        break;
      }
    }

    if (lastStep === undefined) {
      return;
    }

    writer.write({
      type: "finish",
      finishReason: lastStep.finishReason,
      messageMetadata: {
        createdAt: Date.now(),
        rawFinishReason: lastStep.rawFinishReason,
        finishReason: lastStep.finishReason,
        totalUsage,
      },
    });
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
    const { abortSignal, compactionConfig, model, writer } = input;

    const compaction = await this.maybeCompact({
      config: compactionConfig,
      messages: input.messages,
      abortSignal,
      model,
      onBeforeCompact: () => this.announceCompactionStart(writer),
      onAfterCompact: (params) => this.announceCompactionEnd(writer, params),
    });
    const { messages } = compaction;
    compactionConfig.lastKnownPromptMessageCount = messages.length;

    const result = streamText<ToolSet, AgentRuntimeContext>({
      instructions: this.systemPrompt,
      model,
      tools: this.tools,
      // One step per call: `runTurn` owns the step budget, and a step must
      // not execute a tool call whose result is never sent back.
      stopWhen: isStepCount(1),
      reasoning: this.effort
        ? MODEL_EFFORT_TO_REASONING[this.effort]
        : undefined,
      messages,
      abortSignal,
    });

    const reader = toUIMessageStream<ToolSet, AgentUIMessage>({
      stream: result.stream,
      sendStart: false,
      // The single `finish` chunk is written once the last step is known; a
      // per-step one would also report only that step's totals.
      sendFinish: false,
      sendReasoning: true,
      messageMetadata: ({ part }) => {
        if (part.type !== "finish-step") {
          return;
        }
        // Feeds the next iteration's compaction estimate: the prompt's real
        // token count is only known once the model reports it.
        compactionConfig.lastKnownInputTokens = part.usage.inputTokens;
        return {
          createdAt: Date.now(),
          rawFinishReason: part.rawFinishReason,
          finishReason: part.finishReason,
          usage: part.usage,
          providerMetadata: part.providerMetadata,
          performance: part.performance,
        };
      },
    }).getReader();

    // Chunks are forwarded one at a time rather than through
    // `writer.merge`: `merge` pumps asynchronously, so the `finish` chunk
    // written after the loop would overtake a step's remaining chunks —
    // clients treat `finish` as end-of-message.
    //
    // The cast is `toUIMessageStream` defaulting its `UI_MESSAGE` to the
    // generic `UIMessage`, whose metadata is `unknown`; the chunks are the
    // same shape, and `writer` is what actually constrains them. Naming the
    // message type on the call instead would reject the `finish-step`
    // metadata below, which carries keys `AgentUIMetadata` does not declare.
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      writer.write(value);
    }

    try {
      const [step, responseMessages] = await Promise.all([
        result.finalStep,
        result.responseMessages,
      ]);
      const { finishReason, rawFinishReason, usage, toolCalls, toolResults } =
        step;

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
      return undefined;
    }
  }

  private async announceCompactionStart(
    writer: UIMessageStreamWriter<AgentUIMessage>
  ): Promise<void> {
    const createdAt = Date.now();
    writer.write({
      id: generatePartId(),
      type: "data-compaction:start",
      data: {
        createdAt,
      },
    });
    await this.hooks.emit(
      "compaction:start",
      { sessionId: this.sessionId, createdAt },
      this.extensionApi
    );
  }

  private async announceCompactionEnd(
    writer: UIMessageStreamWriter<AgentUIMessage>,
    params: { compacted: boolean; messages: ModelMessage[] }
  ): Promise<void> {
    const createdAt = Date.now();
    writer.write({
      id: generatePartId(),
      type: "data-compaction:end",
      data: {
        compacted: params.compacted,
        messages: params.messages,
        createdAt,
      },
    });
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
