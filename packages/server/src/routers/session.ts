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
  AgentUIMetadata,
  AgentUITools,
} from "@workspace/agent";
import type { AgentContext } from "@workspace/agent/context";
import { SKILL_DIRS, SkillManager } from "@workspace/agent/skill/index";
import { SQLiteStore } from "@workspace/agent/storage/sqlite-store";
import {
  createBashTool,
  createReadFileTool,
  createWriteFileTool,
  createDeleteFileTool,
  createEditFileTool,
  createGrepTool,
  createGlobTool,
  createWebFetchTool,
} from "@workspace/agent/tools/index";
import { createLoadSkillTool } from "@workspace/agent/tools/load-skill";
import {
  generateMessageId,
  generateSessionId,
} from "@workspace/agent/utils/id-util";
import type {
  MessageInsertModel,
  MessageModel,
  SessionModel,
} from "@workspace/db";
import { ModelEffort } from "@workspace/shared/constants";
import type { UIMessagePart } from "ai";
import z from "zod";

import { publicProcedure } from "../index";
import { forkSessionSchema, listSessionMessagesSchema } from "./session.schema";
import { findAiModelById } from "./settings/settings.service";

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
      metadata: message.metadata as AgentUIMetadata,
    });
  }

  return agentUIMessages;
}

const createSession = publicProcedure
  .route({ method: "POST", path: "/sessions" })
  .input(
    type<{
      sessionId: string;
      messages: AgentUIMessage[];
      model: string;
      modelEffort?: string;
    }>()
  )
  .handler(async ({ input }) => {
    const { sessionId, messages, model, modelEffort } = input;

    const aiModel = await findAiModelById(model);
    if (!aiModel) {
      throw new ORPCError("BAD_REQUEST", {
        message: "ai model not found.",
      });
    }

    const provider = createOpenAICompatible({
      apiKey: aiModel.apiKey,
      baseURL: aiModel.apiUrl,
      name: aiModel.provider,
    });

    const selectedModel = provider.chatModel(aiModel.model);
    const workdir = homedir();
    const skillManager = new SkillManager({ dirs: SKILL_DIRS });
    await skillManager.loadSkills(workdir);

    const agentContext: AgentContext = {
      workdir,
      skills: skillManager,
    };

    const systemPrompt = skillManager.appendPrompt("");

    const agent = new Agent({
      name: "main",
      sessionId,
      model: selectedModel,
      systemPrompt,
      effort: Object.values(ModelEffort).includes(modelEffort as ModelEffort)
        ? (modelEffort as ModelEffort)
        : undefined,
      context: agentContext,
      tools: {
        bash: createBashTool({ agentContext }),
        "read-file": createReadFileTool({ agentContext }),
        "write-file": createWriteFileTool({ agentContext }),
        "delete-file": createDeleteFileTool({ agentContext }),
        "edit-file": createEditFileTool({ agentContext }),
        grep: createGrepTool({ agentContext }),
        glob: createGlobTool({ agentContext }),
        "web-fetch": createWebFetchTool({ agentContext }),
        "load-skill": createLoadSkillTool({ agentContext }),
      },
    });

    const stream = await agent.stream({
      messages,
      model: selectedModel,
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
  .route({ method: "GET", path: "/sessions/{sessionId}/messages" })
  .input(listSessionMessagesSchema)
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

    const messages = await store.getAllMessagesBySessionId(session.id);
    const activeBranchMessages = await store.getBranchMessages(
      session.id,
      messages
    );

    return convertAgentUIMessages(activeBranchMessages);
  });

export const forkSession = publicProcedure
  .route({ method: "POST", path: "/sessions/{sessionId}/fork" })
  .input(forkSessionSchema)
  .handler(async ({ input }) => {
    const { sessionId, messageId } = input;

    const store = new SQLiteStore();
    const source = await store.getSessionById(sessionId);
    if (!source) {
      throw new ORPCError("BAD_REQUEST", {
        message: "chat not found.",
      });
    }

    const messages = await store.getAllMessagesBySessionId(sessionId);
    const branchMessages = await store.getBranchMessages(source.id, messages);
    const upToIndex = messageId
      ? branchMessages.findIndex((message) => message.id === messageId)
      : branchMessages.length - 1;
    if (upToIndex < 0) {
      throw new ORPCError("BAD_REQUEST", {
        message: "message not found on branch.",
      });
    }

    const prefix = branchMessages.slice(0, upToIndex + 1);
    if (prefix.length === 0) {
      throw new ORPCError("BAD_REQUEST", {
        message: "nothing to fork.",
      });
    }

    const newSessionId = generateSessionId();
    // Copy rows with fresh ids: message.id is a global primary key, and the
    // fork must be self-contained — later edits in either session must not
    // affect the other.
    const idMap = new Map<string, string>();
    const copies: MessageInsertModel[] = prefix.map((message) => {
      const newId = generateMessageId();
      idMap.set(message.id, newId);
      return {
        id: newId,
        sessionId: newSessionId,
        role: message.role,
        metadata: message.metadata,
        content: message.content,
        parentId: message.parentId
          ? (idMap.get(message.parentId) ?? null)
          : null,
        createdAt: message.createdAt,
      };
    });

    await store.saveSession({
      id: newSessionId,
      title: `Fork: ${source.title}`,
      metadata: "",
      activeHeadId: copies.at(-1)?.id ?? null,
      forkedFromSessionId: source.id,
      forkedFromMessageId: messageId ?? prefix.at(-1)?.id,
    });
    await store.saveMessages(copies);

    return { sessionId: newSessionId };
  });

export const listSessionResources = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/resources" })
  .input(z.object({ sessionId: z.string() }))
  .handler(async () => {
    const workdir = homedir();
    const skillManager = new SkillManager({ dirs: SKILL_DIRS });
    await skillManager.loadSkills(workdir);

    return { skills: skillManager.listAll() };
  });

export { eventIteratorToUnproxiedDataStream };

export const session = {
  create: createSession,
  list: listSessions,
  listSessionMessages,
  listSessionResources,
  fork: forkSession,
};
