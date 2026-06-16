import type { MessageModel } from "@workspace/db";
import {
  convertToModelMessages,
  createUIMessageStream,
  generateText,
  streamText,
} from "ai";
import type { LanguageModel, ToolSet } from "ai";

import { AgentSession } from "./session";
import type { AgentStore } from "./storage";
import { SQLiteStore } from "./storage/sqlite-store";
import type { AgentUIMessage } from "./types";
import { generateMessageId } from "./utils/id-util";

export const TITLE_PROMPT = `Generate a very short thread title (2-5 words max) based on the user's message.
Rules:
- Maximum 30 characters
- No quotes, colons, hashtags, or markdown
- Just the topic/intent, not a full sentence
- If the message is a greeting like "hi" or "hello", respond with just "New conversation"
- Be concise: "Weather in NYC" not "User asking about the weather in New York City"`;

export type AgentOptions = {
  name: string;
  threadId: string;
  model: LanguageModel;
  session?: AgentSession;
  tools?: ToolSet;
  systemPrompt?: string;
};

export type AgentStreamOptions = {
  model: LanguageModel;
  abortSignal?: AbortSignal;
  messages: AgentUIMessage[];
};

export class Agent {
  name: string;
  threadId: string;
  model: LanguageModel;
  systemPrompt?: string;
  session: AgentSession;
  tools: ToolSet;
  store: AgentStore;

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.threadId = options.threadId;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.session = options.session ?? new AgentSession({ messages: [] });
    this.tools = options.tools ?? {};
    this.store = new SQLiteStore();
  }

  async stream({ messages, model, abortSignal }: AgentStreamOptions) {
    let titlePromise: Promise<string> | null = null;

    const mostRecentMessage = messages.at(-1);

    if (!mostRecentMessage) {
      throw new Error("no message.");
    }

    const thread = await this.store.getThreadById(this.threadId);
    if (!thread) {
      await this.store.saveThread({
        id: this.threadId,
        title: "New thread",
        metadata: "",
      });

      // Start title generation in parallel (don't await)
      titlePromise = this.generateChatTitle(mostRecentMessage);
    }

    const previousMessages = await this.store.getMessagesByThreadId(
      this.threadId
    );
    const previousUIMessages = this.toAgentUIMessage(previousMessages);

    const modelMessages = await convertToModelMessages<AgentUIMessage>([
      ...previousUIMessages,
      mostRecentMessage,
    ]);

    if (mostRecentMessage?.role === "user") {
      await this.store.saveMessage({
        id: mostRecentMessage.id,
        threadId: this.threadId,
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
        });

        // Handle title generation in parallel
        // oxlint-disable-next-line typescript/no-floating-promises
        titlePromise?.then(async (title) => {
          await this.store.updateThreadById(this.threadId, title);
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
        });

        writer.merge(
          result.toUIMessageStream({
            sendStart: false,
            generateMessageId,
          })
        );
      },
      originalMessages: previousUIMessages,
      onFinish: async (data) => {
        const finishedMsg = data.responseMessage;
        const existingMsg = await this.store.existsMessages(finishedMsg.id);
        if (existingMsg) {
          await this.store.updateMessage(finishedMsg.id, finishedMsg.parts);
          return;
        }

        await this.store.saveMessage({
          id: finishedMsg.id,
          threadId: this.threadId,
          role: finishedMsg.role,
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
