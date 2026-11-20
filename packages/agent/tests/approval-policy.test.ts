import { APPROVAL_POLICIES } from "@workspace/agent-client";
import { describe, expect, test } from "vitest";

import {
  effectivePolicy,
  policyAnswer,
  resolveServiceDecision,
} from "../src/approval-policy.js";

describe(policyAnswer, () => {
  test("standard asks for a mutation and stays silent for a read", () => {
    expect(policyAnswer("standard", "mutate")).toStrictEqual({
      decision: "ask",
    });
    expect(policyAnswer("standard", "read")).toBeUndefined();
  });

  test("no policy closes a questionnaire, full access included", () => {
    for (const policy of APPROVAL_POLICIES) {
      expect(policyAnswer(policy, "interact")).toStrictEqual({
        decision: "ask",
      });
    }
  });

  test("read-only refuses a mutation and a command", () => {
    expect(policyAnswer("readonly", "mutate")).toStrictEqual({
      decision: "deny",
    });
    expect(policyAnswer("readonly", "exec")).toStrictEqual({
      decision: "deny",
    });
  });
});

describe(resolveServiceDecision, () => {
  test("the read-only cap outranks the host's allow", () => {
    expect(
      resolveServiceDecision({ decision: "allow" }, { decision: "deny" })
    ).toStrictEqual({ decision: "deny" });
  });

  test("a host denial keeps its reason", () => {
    const denial = { decision: "deny" as const, reason: "destructive" };
    expect(resolveServiceDecision(denial, { decision: "allow" })).toStrictEqual(
      denial
    );
  });

  test("an allow closes the host's ask", () => {
    expect(
      resolveServiceDecision({ decision: "ask" }, { decision: "allow" })
    ).toStrictEqual({ decision: "allow" });
  });

  test("a host allow for this call stands over the policy's ask", () => {
    expect(
      resolveServiceDecision({ decision: "allow" }, { decision: "ask" })
    ).toStrictEqual({ decision: "allow" });
  });

  test("either side answers alone", () => {
    expect(resolveServiceDecision({ decision: "ask" })).toStrictEqual({
      decision: "ask",
    });
    expect(
      resolveServiceDecision(undefined, { decision: "ask" })
    ).toStrictEqual({ decision: "ask" });
    expect(resolveServiceDecision()).toBeUndefined();
  });
});

describe(effectivePolicy, () => {
  test("an attended run keeps the stored policy", () => {
    expect(effectivePolicy("unrestricted", true)).toBe("unrestricted");
    expect(effectivePolicy("edit", true)).toBe("edit");
  });

  test("an unattended run never auto-approves a mutation", () => {
    expect(effectivePolicy("edit", false)).toBe("standard");
    expect(effectivePolicy("unrestricted", false)).toBe("standard");
    expect(effectivePolicy("standard", false)).toBe("standard");
  });

  test("read-only needs no tightening", () => {
    expect(effectivePolicy("readonly", false)).toBe("readonly");
  });
});
