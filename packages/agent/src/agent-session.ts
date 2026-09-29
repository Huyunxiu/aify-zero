import { AgentTurnBuilder } from "@workspace/agent-client";
import type { AgentTurn } from "@workspace/agent-client";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { addLanguageModelUsage } from "ai/internal";

import type { AgentStepResult } from "./agents";
import type { AgentToolSet } from "./types";
import { convertAgentTurnToModalMessage } from "./utils/convert-to-model-message";
import { generateTurnId } from "./utils/id-util";

export type AgentSessionOptions = {
  turns: AgentTurn<AgentToolSet>[];
  builder?: AgentTurnBuilder<AgentToolSet>;
};

export class AgentSession {
  turns: AgentTurn<AgentToolSet>[];
  modelMessages: ModelMessage[];
  builder?: AgentTurnBuilder<AgentToolSet>;
  lastKnownInputTokens: number;
  usage?: LanguageModelUsage;
  totalUsage?: LanguageModelUsage;

  constructor({ turns }: AgentSessionOptions) {
    this.turns = turns;
    this.lastKnownInputTokens =
      turns.findLast((e) => e.usage)?.usage?.inputTokens ?? 0;
    this.modelMessages = [];
  }

  async startTurn({ turns }: AgentSessionOptions): Promise<string> {
    this.turns = turns;
    this.lastKnownInputTokens =
      this.turns.findLast((e) => e.usage)?.usage?.inputTokens ?? 0;
    this.modelMessages = await convertAgentTurnToModalMessage<AgentToolSet>(
      this.turns
    );
    this.builder = new AgentTurnBuilder<AgentToolSet>({
      turns: this.turns,
    });
    return generateTurnId();
  }

  finishStep(stepResult: AgentStepResult) {
    this.modelMessages = stepResult.messages;

    if (this.usage === undefined) {
      this.usage = stepResult.usage;
    } else {
      this.usage = stepResult.usage;
    }

    if (this.totalUsage === undefined) {
      this.totalUsage = this.usage;
    } else if (this.usage) {
      this.totalUsage = addLanguageModelUsage(this.totalUsage, this.usage);
    }

    this.lastKnownInputTokens =
      this.usage.inputTokens ?? this.lastKnownInputTokens;
  }

  finishTurn({ turn }: { turn: AgentTurn<AgentToolSet> | undefined }) {
    if (!turn) {
      return;
    }

    this.turns.push(turn);
  }
}
