import { convertToModelMessages, ToolLoopAgent } from "ai";
import type { LanguageModel, ToolSet, UIMessage } from "ai";

import { AgentSession } from "./session";

type AgentOptions = {
  name: string;
  session?: AgentSession;
  tools?: ToolSet;
  systemPrompt?: string;
};

type AgentStreamOptions = {
  model: LanguageModel;
  abortSignal?: AbortSignal;
  messages: UIMessage[];
};

class Agent {
  name: string;
  systemPrompt?: string;
  session: AgentSession;
  tools: ToolSet;

  constructor(options: AgentOptions) {
    this.name = options.name;
    this.systemPrompt = options.systemPrompt;
    this.session = options.session ?? new AgentSession({ messages: [] });
    this.tools = options.tools ?? {};
  }

  async stream({ messages, model, abortSignal }: AgentStreamOptions) {
    const aiAgent = new ToolLoopAgent({
      instructions: this.systemPrompt,
      model,
      tools: this.tools,
    });

    const modelMessages = await convertToModelMessages([
      ...this.session.messages,
      ...messages,
    ]);
    return await aiAgent.stream({
      abortSignal,
      messages: modelMessages,
    });
  }
}

export { Agent };
