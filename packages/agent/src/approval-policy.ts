import type { ApprovalPolicy } from "@workspace/agent-client";
import { DEFAULT_APPROVAL_POLICY } from "@workspace/agent-client";

import type { ApprovalClass } from "./approval-classes";
import type { ToolCallHookEvent, ToolStartDecision } from "./hooks-manager";

export type { ApprovalPolicy };
export { DEFAULT_APPROVAL_POLICY };

/**
 * 档位 × 类别 → 回答。
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
 * 宿主的回答和策略的回答合成服务层的答案。
 *
 * 四条规则，按序：
 * 1. 策略说 deny，就是 deny —— 只读是封顶，宿主的放行翻不过去。
 * 2. 宿主说 deny，就是 deny —— 策略只能放松「问」，不能推翻「不行」。
 * 3. 策略说 allow 而宿主说 ask，只有**未知类别**才取 allow：这类询问的意思是
 *    「不知道它做什么」，用户已经说了不用问。已知的改动类不在此列 —— 服务器
 *    明确说它会破坏东西时，全放行也得先问一句。
 * 4. 其余照旧：宿主有意见听宿主，没有就听策略。
 */
export function resolveServiceDecision(
  host: ToolStartDecision | undefined,
  policy: ToolStartDecision | undefined,
  toolClass: ApprovalClass
): ToolStartDecision | undefined {
  if (policy?.decision === "deny") {
    return policy;
  }

  if (host?.decision === "deny") {
    return host;
  }

  if (
    policy?.decision === "allow" &&
    host?.decision === "ask" &&
    toolClass === "unknown"
  ) {
    return { decision: "allow" };
  }

  return host ?? policy;
}

/**
 * 没人看着的时候把档位收紧。
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
