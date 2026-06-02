import type { UIMessage } from "ai";

type AgentSessionOptions = {
  messages: UIMessage[];
};

class AgentSession {
  messages: UIMessage[];

  constructor({ messages }: AgentSessionOptions) {
    this.messages = messages;
  }
}

export { AgentSession };
