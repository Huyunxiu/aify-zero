import { homedir } from "node:os";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  eventIteratorToUnproxiedDataStream,
  ORPCError,
  streamToEventIterator,
  type,
} from "@orpc/server";
import { Agent } from "@workspace/agent";
import type {
  AgentUIDataParts,
  AgentUIMessage,
  AgentUITools,
} from "@workspace/agent";
import type { AgentContext } from "@workspace/agent/context";
import { SQLiteStore } from "@workspace/agent/storage/sqlite-store";
import {
  createBashTool,
  createReadFileTool,
  createWriteFileTool,
  createDeleteFileTool,
  createEditFileTool,
} from "@workspace/agent/tools/index";
import type { MessageModel, ThreadModel } from "@workspace/db";
import type { UIMessagePart } from "ai";
import z from "zod";

import { publicProcedure } from "../index";

function convertAgentUIMessages(
  messages: MessageModel[]
): AgentUIMessage[] | undefined {
  if (!messages?.length) {
    return;
  }

  const agentUIMessages: AgentUIMessage[] = [];

  for (const message of messages) {
    agentUIMessages.push({
      id: message.id,
      role: message.role as "system" | "user" | "assistant",
      parts: message.content as UIMessagePart<AgentUIDataParts, AgentUITools>[],
    });
  }

  return agentUIMessages;
}

const createThread = publicProcedure
  .route({ method: "POST", path: "/threads" })
  .input(type<{ threadId: string; messages: AgentUIMessage[] }>())
  .handler(async ({ context, input }) => {
    const { threadId, messages } = input;

    const provider = createOpenAICompatible({
      apiKey: context.env.OPENAI_COMPATIBLE_BASE_KEY,
      baseURL: context.env.OPENAI_COMPATIBLE_API_URL,
      name: context.env.OPENAI_COMPATIBLE_PROVIDER,
    });

    const model = provider.chatModel(context.env.OPENAI_COMPATIBLE_MODEL);

    const agentContext: AgentContext = {
      workdir: homedir(),
    };

    const agent = new Agent({
      name: "main",
      threadId,
      model,
      systemPrompt: "You are a helpful assistant.",
      context: agentContext,
      tools: {
        bash: createBashTool({ agentContext }),
        "read-file": createReadFileTool({ agentContext }),
        "write-file": createWriteFileTool({ agentContext }),
        "delete-file": createDeleteFileTool({ agentContext }),
        "edit-file": createEditFileTool({ agentContext }),
      },
    });

    const stream = await agent.stream({
      messages,
      model,
    });

    return streamToEventIterator(stream);
  });

const listThreads = publicProcedure
  .route({ method: "GET", path: "/threads" })
  .input(
    type<{ cursor?: string; limit?: number; direction?: "asc" | "desc" }>()
  )
  .handler(async ({ input }) => {
    const { cursor, limit, direction } = input;
    const store = new SQLiteStore();
    const threads = await store.listThreads({
      cursor,
      limit,
      direction,
    });
    return { threads };
  });

export const listThreadMessages = publicProcedure
  .route({ method: "GET", path: "/threads/{threadId}" })
  .input(z.object({ threadId: z.string() }))
  .handler(async ({ input }) => {
    const { threadId } = input;

    let thread: ThreadModel | null;

    const store = new SQLiteStore();
    try {
      thread = await store.getThreadById(threadId);
    } catch {
      throw new ORPCError("BAD_REQUEST", {
        message: "chat not found.",
      });
    }

    if (!thread) {
      return [];
    }

    const messages = await store.getMessagesByThreadId(thread.id);
    return convertAgentUIMessages(messages);
  });

export { eventIteratorToUnproxiedDataStream };

export const thread = {
  create: createThread,
  list: listThreads,
  listThreadMessages,
};
