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
import type { MessageModel, SessionModel } from "@workspace/db";
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

const createSession = publicProcedure
  .route({ method: "POST", path: "/sessions" })
  .input(type<{ sessionId: string; messages: AgentUIMessage[] }>())
  .handler(async ({ context, input }) => {
    const { sessionId, messages } = input;

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
      sessionId,
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

const listSessions = publicProcedure
  .route({ method: "GET", path: "/sessions" })
  .input(
    type<{ cursor?: string; limit?: number; direction?: "asc" | "desc" }>()
  )
  .handler(async ({ input }) => {
    const { cursor, limit, direction } = input;
    const store = new SQLiteStore();
    const sessions = await store.listSessions({
      cursor,
      limit,
      direction,
    });
    return { sessions };
  });

export const listSessionMessages = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async ({ input }) => {
    const { sessionId } = input;

    let session: SessionModel | null;

    const store = new SQLiteStore();
    try {
      session = await store.getSessionById(sessionId);
    } catch {
      throw new ORPCError("BAD_REQUEST", {
        message: "chat not found.",
      });
    }

    if (!session) {
      return [];
    }

    const messages = await store.getMessagesBySessionId(session.id);
    return convertAgentUIMessages(messages);
  });

export { eventIteratorToUnproxiedDataStream };

export const session = {
  create: createSession,
  list: listSessions,
  listSessionMessages,
};
