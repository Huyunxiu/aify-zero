import type { ApprovalPolicy } from "@workspace/agent-client";
import { DEFAULT_APPROVAL_POLICY } from "@workspace/agent-client";

import type { ApprovalClass } from "./approval-classes";
import type { ToolCallHookEvent, ToolStartDecision } from "./hooks-manager";

/**
 * 策略 × 类别 → 回答。
 *
 * 缺席的一格表示「不表态」：交给宿主的规则和现有默认，不凭空多出询问。
 * standard 一行就是今天的行为，所以它取代 `DEFAULT_TOOL_APPROVAL_TOOLS`，
 * 询问集合只剩这一处权威。
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
 * 没人看着的时候把策略收紧。
 *
 * 编辑和全放行都意味着「自动放行改动」，半夜被定时器唤起来正是它们最不该
 * 生效的时刻。只读不用收：它本来就不放行任何东西。
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

/** 类别解析：内置查表，MCP 查注解。由组合根注入，agent 包不认识管理器。 */
export type ApprovalClassResolver = (
  request: ToolCallHookEvent
) => ApprovalClass;
