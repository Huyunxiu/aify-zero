import type { ApprovalPolicy } from "@workspace/agent-client";
import { DEFAULT_APPROVAL_POLICY } from "@workspace/agent-client";

import type { ApprovalClass } from "./approval-classes";
import type { ToolCallHookEvent, ToolStartDecision } from "./hooks-manager";

/**
 * Policy × class to an answer.
 *
 * A missing cell means "no opinion": the host rules and the current defaults answer,
 * so no new ask appears. The standard row is today's behavior, so it replaces
 * `DEFAULT_TOOL_APPROVAL_TOOLS` and holds the only ask set.
 */
const ANSWERS: Readonly<
  Record<
    ApprovalPolicy,
    Readonly<Partial<Record<ApprovalClass, ToolStartDecision>>>
  >
> = {
  standard: {
    mutate: { decision: "ask" },
    interact: { decision: "ask" },
  },
  edit: {
    mutate: { decision: "allow" },
    interact: { decision: "ask" },
  },
  readonly: {
    mutate: { decision: "deny" },
    exec: { decision: "deny" },
    interact: { decision: "ask" },
  },
  unrestricted: {
    mutate: { decision: "allow" },
    exec: { decision: "allow" },
    interact: { decision: "allow" },
    unknown: { decision: "allow" },
  },
};

export function policyAnswer(
  policy: ApprovalPolicy,
  toolClass: ApprovalClass
): ToolStartDecision | undefined {
  return ANSWERS[policy][toolClass];
}

/**
 * Folds the host's answer and the policy's answer into the service answer.
 *
 * A refusal from either side is the answer, and it keeps its reason. Next comes
 * the host's allow: it looked at this call, not at a class, so it closes a
 * policy that would otherwise ask. Everything else follows the policy, because
 * the user picked it for the session — that includes a host's `ask`, which a
 * policy that allows the class also allows.
 */
export function resolveServiceDecision(
  host?: ToolStartDecision,
  policy?: ToolStartDecision
): ToolStartDecision | undefined {
  if (host?.decision === "deny") {
    return host;
  }

  if (policy?.decision === "deny") {
    return policy;
  }

  if (host?.decision === "allow") {
    return host;
  }

  return policy ?? host;
}

/**
 * Tighten the policy when nobody watches the Run.
 *
 * Edit and Unrestricted both let a change pass with no question, and a Timer at night
 * is the worst moment for them. Read-Only needs no tightening: it allows nothing.
 */
export function effectivePolicy(
  stored: ApprovalPolicy,
  attended: boolean
): ApprovalPolicy {
  if (attended || stored === "readonly") {
    return stored;
  }

  return DEFAULT_APPROVAL_POLICY;
}

/** Class resolution: the built-in table, or MCP annotations. The composition root injects it; this package does not know the manager. */
export type ApprovalClassResolver = (
  request: ToolCallHookEvent
) => ApprovalClass;
