import {
  AgentTurnBuilder,
  findTurnWithoutToolResult,
} from "@workspace/agent-client";
import type { AgentTurn } from "@workspace/agent-client";
import type { TurnModel } from "@workspace/db";
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
  usage?: LanguageModelUsage;
  totalUsage?: LanguageModelUsage;

  constructor({ turns }: AgentSessionOptions) {
    this.turns = turns;
    this.modelMessages = [];
  }

  static toAgentTurns(turns: TurnModel[]): AgentTurn<AgentToolSet>[] {
    return turns.map((e) => e.content as AgentTurn<AgentToolSet>);
  }

  async startTurn({ turns }: AgentSessionOptions): Promise<string> {
    this.turns = turns;
    this.modelMessages = await convertAgentTurnToModalMessage<AgentToolSet>(
      this.turns
    );
    this.builder = new AgentTurnBuilder<AgentToolSet>({
      turns: this.turns,
    });
    const turn = findTurnWithoutToolResult(this.turns);
    return turn ? turn.id : generateTurnId();
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
  }

  finishTurn({ turn }: { turn: AgentTurn<AgentToolSet> | undefined }) {
    if (!turn) {
      return;
    }

    this.turns.push(turn);
  }
}
