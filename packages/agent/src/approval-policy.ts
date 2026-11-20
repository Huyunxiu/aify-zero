import type { ApprovalPolicy } from "@workspace/agent-client";

import type { ApprovalClass } from "./approval-classes";
import type { ToolCallHookEvent, ToolStartDecision } from "./hooks-manager";

/**
 * Policy × class to an answer.
 *
 * A missing cell means "no opinion": the host rules answer, and the call runs. No row asks
 * before a change any more: the tier that did is gone, so the only question a policy
 * raises is the questionnaire's, and that one is not in the table.
 *
 * `interact` has no cell here, on purpose. See `policyAnswer`.
 */
/**
 * What a policy calls a class when it refuses one, in the words the model reads.
 *
 * One list feeds two readers: the refusal sentence the model receives, and the notice
 * the prompt carries. A class that has no noun is left out of both, so a policy that
 * refuses it in the table still says nothing about it — keep this list complete.
 */
export const CLASS_NOUN: Readonly<Partial<Record<ApprovalClass, string>>> = {
  mutate: "writes to disk",
  exec: "shell commands",
};

/** What the read-only policy says when it refuses a class. The model reads it alone. */
export const POLICY_REFUSAL: Readonly<Partial<Record<ApprovalClass, string>>> =
  {
    mutate: `This session's approval policy refuses ${CLASS_NOUN.mutate}.`,
    exec: `This session's approval policy refuses ${CLASS_NOUN.exec}.`,
  };

const ANSWERS: Readonly<
  Record<
    ApprovalPolicy,
    Readonly<Partial<Record<ApprovalClass, ToolStartDecision>>>
  >
> = {
  edit: {
    mutate: { decision: "allow" },
  },
  readonly: {
    mutate: { decision: "deny", reason: POLICY_REFUSAL.mutate },
    exec: { decision: "deny", reason: POLICY_REFUSAL.exec },
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

/** Class resolution: the built-in table, or MCP annotations. The composition root injects it; this package does not know the manager. */
export type ApprovalClassResolver = (
  request: ToolCallHookEvent
) => ApprovalClass;
