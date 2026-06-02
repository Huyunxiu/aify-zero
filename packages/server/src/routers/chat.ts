import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  eventIteratorToUnproxiedDataStream,
  streamToEventIterator,
  type,
} from "@orpc/server";
import { Agent } from "@workspace/agent";
import type { UIMessage } from "ai";

import { publicProcedure } from "../index";

export const chat = publicProcedure
  .input(type<{ chatId: string; messages: UIMessage[] }>())
  .handler(async ({ context, input }) => {
    const { chatId, messages } = input;

    const agent = new Agent({
      name: "main",
      systemPrompt: "You are a helpful assistant.",
    });

    const provider = createOpenAICompatible({
      apiKey: context.env.OPENAI_COMPATIBLE_BASE_KEY,
      baseURL: context.env.OPENAI_COMPATIBLE_API_URL,
      name: context.env.OPENAI_COMPATIBLE_PROVIDER,
    });

    const result = await agent.stream({
      messages,
      model: provider.chatModel(`${context.env.OPENAI_COMPATIBLE_MODEL}`),
    });

    return streamToEventIterator(result.toUIMessageStream());
  });

export { eventIteratorToUnproxiedDataStream };
