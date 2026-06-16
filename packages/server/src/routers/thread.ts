import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  eventIteratorToUnproxiedDataStream,
  streamToEventIterator,
  type,
} from "@orpc/server";
import { Agent } from "@workspace/agent";
import type { AgentUIMessage } from "@workspace/agent";
import {
  createReadFileTool,
  createWriteFileTool,
  createDeleteFileTool,
  createEditFileTool,
} from "@workspace/agent/tools/index";

import { publicProcedure } from "../index";

export const thread = publicProcedure
  .input(type<{ threadId: string; messages: AgentUIMessage[] }>())
  .handler(async ({ context, input }) => {
    const { threadId, messages } = input;

    const provider = createOpenAICompatible({
      apiKey: context.env.OPENAI_COMPATIBLE_BASE_KEY,
      baseURL: context.env.OPENAI_COMPATIBLE_API_URL,
      name: context.env.OPENAI_COMPATIBLE_PROVIDER,
    });

    const model = provider.chatModel(context.env.OPENAI_COMPATIBLE_MODEL);

    const agent = new Agent({
      name: "main",
      threadId,
      model,
      systemPrompt: "You are a helpful assistant.",
      tools: {
        "read-file": createReadFileTool(),
        "write-file": createWriteFileTool(),
        "delete-file": createDeleteFileTool(),
        "edit-file": createEditFileTool(),
      },
    });

    const stream = await agent.stream({
      messages,
      model,
    });

    return streamToEventIterator(stream);
  });

export { eventIteratorToUnproxiedDataStream };
