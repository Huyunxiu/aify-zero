import { DevToolsTelemetry } from "@ai-sdk/devtools";
import type { MessageModel } from "@workspace/db";
import {
  convertToModelMessages,
  createUIMessageStream,
  generateText,
  isStepCount,
  registerTelemetry,
  streamText,
} from "ai";
import type { LanguageModel, ToolSet } from "ai";

import type { AgentContext } from "./context";
import { AgentSession } from "./session";
import type { AgentStore } from "./storage";
import { SQLiteStore } from "./storage/sqlite-store";
import type { AgentUIMessage } from "./types";
import { generateMessageId } from "./utils/id-util";

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

    const modelMessages = await convertToModelMessages<AgentUIMessage>([
      ...previousUIMessages,
      mostRecentMessage,
    ]);

    if (mostRecentMessage?.role === "user") {
      await this.store.saveMessage({
        id: mostRecentMessage.id,
        sessionId: this.sessionId,
        role: "user",
        metadata: "",
        content: mostRecentMessage.parts,
        createdAt: new Date(),
      });
    }

    return createUIMessageStream<AgentUIMessage>({
      execute: ({ writer }) => {
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
            type: "data-chat-title",
            data: title,
            transient: true,
          });
        });

        const result = streamText({
          system: this.systemPrompt,
          model,
          messages: modelMessages,
          tools: this.tools,
          abortSignal,
          stopWhen: isStepCount(100),
        });

        writer.merge(
          result.toUIMessageStream({
            sendStart: false,
            sendReasoning: true,
            sendFinish: true,
            generateMessageId,
            messageMetadata: ({ part }) => {
              if (part.type === "finish") {
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
      originalMessages: previousUIMessages,
      onFinish: async (data) => {
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
}
