import { isAgentToolPart } from "./types";
import type {
  AgentToolPart,
  AgentTurn,
  TextStreamToolApprovalResponseEvent,
} from "./types";

export function findToolApprovalRequests(turns: AgentTurn[]) {
  const turn = turns.findLast((e) => e.type === "assistant");
  if (!turn) {
    return [];
  }

  const parts: AgentToolPart[] = [];

  for (const step of turn.content) {
    for (const part of step.content) {
      if (isAgentToolPart(part) && part.state === "approval-requested") {
        parts.push(part);
      }
    }
  }

  return parts;
}

export function findToolPartByToolCallId(
  turns: AgentTurn[],
  toolCallId: string | undefined
) {
  if (!toolCallId) {
    return null;
  }

  for (const turn of turns) {
    for (const step of turn.content) {
      for (const part of step.content) {
        if (isAgentToolPart(part) && part.toolCallId === toolCallId) {
          return { turn, step, part };
        }
      }
    }
  }

  return null;
}

export function findTurnWithoutToolResult(turns: AgentTurn[]) {
  for (const turn of turns) {
    for (const step of turn.content) {
      for (const part of step.content) {
        if (isAgentToolPart(part) && part.state === "approval-responded") {
          return turn;
        }
      }
    }
  }

  return null;
}

export function addToolApprovalResponse(
  turns: AgentTurn[],
  approvals?: TextStreamToolApprovalResponseEvent[]
): AgentTurn[] {
  if (!approvals?.length || !turns.length) {
    return [];
  }

  const changedTurns: AgentTurn[] = [];
  for (const approval of approvals) {
    const turn = turns.find((e) => e.id === approval.turnId);
    if (!turn) {
      continue;
    }

    const step = turn.content.find((e) => e.id === approval.stepId);
    if (!step) {
      continue;
    }

    const part = step.content.find(
      (e) =>
        isAgentToolPart(e) &&
        e.state === "approval-requested" &&
        e.approval.id === approval.approvalId
    ) as AgentToolPart | undefined;
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
