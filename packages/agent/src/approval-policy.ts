import type { ApprovalPolicy } from "@workspace/agent-client";
import { UNATTENDED_APPROVAL_POLICY } from "@workspace/agent-client";

import type { ApprovalClass } from "./approval-classes";
import type { ToolCallHookEvent, ToolStartDecision } from "./hooks-manager";

/**
 * Policy × class to an answer.
 *
 * A missing cell means "no opinion": the host rules and the current defaults answer,
 * so no new ask appears. The cautious row is the one that asks before a change; it and
 * the built-in defaults answer the same set that `DEFAULT_TOOL_APPROVAL_TOOLS` did.
 *
 * `interact` has no cell here, on purpose. See `policyAnswer`.
 */
const ANSWERS: Readonly<
  Record<
    ApprovalPolicy,
    Readonly<Partial<Record<ApprovalClass, ToolStartDecision>>>
  >
> = {
  cautious: {
    mutate: { decision: "ask" },
  },
  edit: {
    mutate: { decision: "allow" },
  },
  readonly: {
    mutate: { decision: "deny" },
    exec: { decision: "deny" },
  },
  unrestricted: {
    mutate: { decision: "allow" },
    exec: { decision: "allow" },
    unknown: { decision: "allow" },
  },
};

/**
 * The answer a policy gives for one class.
 *
 * A questionnaire is the one call that no policy closes. Its ask is not a question
 * about the call: the call is the question, and the answers come back on the approval.
 * A policy that allowed it would not make the session quieter — it would hand the tool
 * nothing to read, so every questionnaire fails with no answers. The rule therefore
 * lives here, above the table, so no row can spell the mistake.
 */
export function policyAnswer(
  policy: ApprovalPolicy,
  toolClass: ApprovalClass
): ToolStartDecision | undefined {
  if (toolClass === "interact") {
    return { decision: "ask" };
  }

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
 * is the worst moment for them. Read-Only allows nothing, and a cautious row already
 * asks, so neither needs the change.
 */
export function effectivePolicy(
  stored: ApprovalPolicy,
  attended: boolean
): ApprovalPolicy {
  if (attended || stored === "readonly" || stored === "cautious") {
    return stored;
  }

  return UNATTENDED_APPROVAL_POLICY;
}

/** Class resolution: the built-in table, or MCP annotations. The composition root injects it; this package does not know the manager. */
export type ApprovalClassResolver = (
  request: ToolCallHookEvent
) => ApprovalClass;
