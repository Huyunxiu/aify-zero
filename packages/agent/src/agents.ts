import { DevToolsTelemetry } from "@ai-sdk/devtools";
import type { MessageModel } from "@workspace/db";
import {
  convertToModelMessages,
  createUIMessageStream,
  generateText,
  isStepCount,
  registerTelemetry,
  ToolLoopAgent,
  toUIMessageStream,
} from "ai";
import type { LanguageModel, ModelMessage, ToolSet, UIMessagePart } from "ai";

import { compactMessages, shouldCompact } from "./compaction/compaction";
import type { AgentContext } from "./context";
import { AgentSession } from "./session";
import type { AgentStore } from "./storage";
import { SQLiteStore } from "./storage/sqlite-store";
import type {
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

export type AgentOptions = {
  name: string;
  sessionId: string;
  model: LanguageModel;
  session?: AgentSession;
  tools?: ToolSet;
  systemPrompt?: string;
  context: AgentContext;
};

export type AgentStreamOptions = {
  model: LanguageModel;
  abortSignal?: AbortSignal;
  messages: AgentUIMessage[];
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

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.sessionId = options.sessionId;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.session = options.session ?? new AgentSession({ messages: [] });
    this.tools = options.tools ?? {};
    this.store = new SQLiteStore();
    this.context = options.context;
  }

  async stream({ messages, model, abortSignal }: AgentStreamOptions) {
    let titlePromise: Promise<string> | null = null;

    const mostRecentMessage = messages.at(-1);

    if (!mostRecentMessage) {
      throw new Error("no message.");
    }

    const session = await this.store.getSessionById(this.sessionId);
    if (!session) {
      await this.store.saveSession({
        id: this.sessionId,
        title: "New session",
        metadata: "",
      });

      // Start title generation in parallel (don't await)
      titlePromise = this.generateChatTitle(mostRecentMessage);
    }

    const previousMessages = await this.store.getMessagesBySessionId(
      this.sessionId
    );
    const previousUIMessages = this.toAgentUIMessage(previousMessages);
    const originalMessages = [...previousUIMessages, mostRecentMessage];
    const modelMessages = await this.convertToModalMessage(originalMessages);

    if (mostRecentMessage?.role === "user") {
      await this.store.saveMessage({
        id: mostRecentMessage.id,
        sessionId: this.sessionId,
        role: "user",
        metadata: "{}",
        content: mostRecentMessage.parts,
        createdAt: new Date(),
      });
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
        // oxlint-disable-next-line typescript/no-floating-promises
        titlePromise?.then(async (title) => {
          await this.store.updateSessionById(this.sessionId, title);
          writer.write({
            type: "data-session:title",
            data: title,
            transient: true,
          });
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

        const agent = new ToolLoopAgent({
          instructions: this.systemPrompt,
          model,
          tools: this.tools,
          stopWhen: isStepCount(100),
          prepareCall: async (options) => {
            if (!options.messages) {
              return options;
            }

            const compaction = await this.maybeCompact({
              config: compactionConfig,
              messages: options.messages,
              abortSignal,
              model,
              onBeforeCompact() {
                writer.write({
                  id: generatePartId(),
                  type: "data-compaction:start",
                  data: {
                    createdAt: Date.now(),
                  },
                });
              },
              onAfterCompact(params) {
                writer.write({
                  id: generatePartId(),
                  type: "data-compaction:end",
                  data: {
                    compacted: params.compacted,
                    messages: params.messages,
                    createdAt: Date.now(),
                  },
                });
              },
            });

            compactionConfig.lastKnownPromptMessageCount =
              compaction.messages.length;

            return {
              ...options,
              messages: compaction.messages,
            };
          },
        });

        const result = await agent.stream({
          messages: modelMessages,
          abortSignal,
        });

        writer.merge(
          toUIMessageStream({
            stream: result.stream,
            sendStart: false,
            sendReasoning: true,
            sendFinish: true,
            generateMessageId,
            messageMetadata: ({ part }) => {
              if (part.type === "finish-step") {
                compactionConfig.lastKnownInputTokens = part.usage.inputTokens;
                return {
                  createdAt: Date.now(),
                  rawFinishReason: part.rawFinishReason,
                  finishReason: part.finishReason,
                  usage: part.usage,
                  providerMetadata: part.providerMetadata,
                  performance: part.performance,
                };
              } else if (part.type === "finish") {
                return {
                  createdAt: Date.now(),
                  rawFinishReason: part.rawFinishReason,
                  finishReason: part.finishReason,
                  totalUsage: part.totalUsage,
                };
              }
            },
          })
        );
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
          return;
        }

        await this.store.saveMessage({
          id: finishedMsg.id,
          sessionId: this.sessionId,
          role: finishedMsg.role,
          metadata: finishedMsg.metadata,
          content: finishedMsg.parts,
          createdAt: new Date(),
        });
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
   * Runs the compaction pipeline once if the session's input-token estimate
   * is over the configured threshold. Mutates neither input; returns the new
   * messages array and (possibly updated) session.
   *
   * Kept in the tool-loop (rather than the AI SDK's `prepareStep` hook) so
   * the compacted messages flow through the same `messages` variable the
   * harness uses to rebuild `session.history` after the step.
   */
  private async maybeCompact(input: {
    readonly force?: boolean;
    readonly config: CompactionConfig;
    readonly abortSignal?: AbortSignal;
    readonly messages: ModelMessage[];
    readonly model: LanguageModel;
    readonly onBeforeCompact?: () => void;
    readonly onAfterCompact?: (params: {
      compacted: boolean;
      messages: ModelMessage[];
    }) => void;
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

    onBeforeCompact?.();

    messages = await compactMessages(
      messages,
      model,
      config,
      abortSignal,
      true
    );

    const result = { compacted: true, messages };

    onAfterCompact?.(result);

    return result;
  }
}
