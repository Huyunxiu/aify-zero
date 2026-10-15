import { AgentTurnBuilder, isAgentToolPart } from "@workspace/agent-client";
import type { AgentDynamicToolPart, AgentToolPart, AgentTurn, TextStreamToolApprovalResponseEvent } from "@workspace/agent-client";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { addLanguageModelUsage } from "ai/internal";

import type { AgentStepResult } from "./agents";
import type { AgentToolSet } from "./types";
import { convertAgentTurnToModalMessage } from "./utils/convert-to-model-message";
import { generateTurnId } from "./utils/id-util";
import type { TurnModel } from "@workspace/db";

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

  applyToolApprovals(
    approvals?: readonly TextStreamToolApprovalResponseEvent[]
  ): AgentTurn<AgentToolSet>[] {
    const { turns } = this;
    if (!approvals?.length || !turns.length) {
      return [];
    }

    const turn = turns.findLast(e => e.type === "assistant");
    if (!turn) {
      return [];
    }

    const changedTurns: AgentTurn<AgentToolSet>[] = [];
    for (const approval of approvals) {
      if (approval.turnId !== turn.id) {
        continue;
      }

      const step = turn.content.find(e => e.id === approval.stepId);
      if (!step) {
        continue;
      }

      const part = step.content.find(e => isAgentToolPart(e) && e.state === "approval-requested" && e.approval.id === approval.approvalId) as AgentToolPart | AgentDynamicToolPart | undefined;
      if (!part) {
        continue;
      }

      part.state = "approval-responded";
      part.approval = {
        ...(part.approval ?? {
          id: approval.approvalId,
          createdAt: approval.createdAt,
        }),
        id: approval.approvalId,
        approved: approval.approved,
        approvedAt: approval.createdAt,
        ...(approval.reason ? { reason: approval.reason } : {}),
      };
      if (approval.providerExecuted) {
        part.providerExecuted = approval.providerExecuted;
      }
      if (approval.providerMetadata) {
        part.callProviderMetadata = approval.providerMetadata;
      }

      if (!changedTurns.includes(turn)) {
        changedTurns.push(turn);
      }
    }

    return changedTurns;
  }

  findAwaitingToolApprovals() {
    const { turns } = this;

    const turn = turns.findLast(e => e.type === "assistant");
    if (!turn) {
      return 0;
    }

    let count = 0;

    for (const step of turn.content) {
      for (const part of step.content) {
        if (isAgentToolPart(part) && part.state === "approval-requested") {
          count++;
        }
      }
    }

    return count;
  }

  findToolPartByToolCallId(toolCallId: string | undefined) {
    if (!toolCallId) {
      return null;
    }

    const { turns } = this;

    const turn = turns.findLast(e => e.type === "assistant");
    if (!turn) {
      return null;
    }

    for (const step of turn.content) {
      for (const part of step.content) {
        if (isAgentToolPart(part) && part.toolCallId === toolCallId) {
          return { turn, step, part };
        }
      }
    }

    return null;
  }

  findTurnWithoutToolResult() {
    const { turns } = this;

    const turn = turns.findLast(e => e.type === "assistant");
    if (!turn) {
      return null;
    }

    for (const step of turn.content) {
      for (const part of step.content) {
        if (isAgentToolPart(part) && part.state === "approval-responded") {
          return turn;
        }
      }
    }

    return null;
  }

  static toAgentTurns(turns: TurnModel[]): AgentTurn<AgentToolSet>[] {
    return turns.map((e) => e.content as AgentTurn<AgentToolSet>);
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
    const turn = this.findTurnWithoutToolResult();
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
