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
});

describe(resolveServiceDecision, () => {
  test("the read-only cap outranks the host's allow", () => {
    expect(policyAnswer("readonly", "mutate")).toStrictEqual({
      decision: "deny",
    });
    expect(
      resolveServiceDecision(
        { decision: "allow" },
        { decision: "deny" },
        "mutate"
      )
    ).toStrictEqual({ decision: "deny" });
  });

  test("a host denial keeps its reason", () => {
    const denial = { decision: "deny" as const, reason: "destructive" };
    expect(
      resolveServiceDecision(denial, { decision: "allow" }, "mutate")
    ).toStrictEqual(denial);
  });

  test("an allow relaxes the ask on a call we know nothing about", () => {
    expect(
      resolveServiceDecision(
        { decision: "ask" },
        { decision: "allow" },
        "unknown"
      )
    ).toStrictEqual({ decision: "allow" });
  });

  test("an allow does not relax the ask on a known mutation", () => {
    // 服务器自己说它会破坏东西时，全放行也得先问一句。
    expect(
      resolveServiceDecision(
        { decision: "ask" },
        { decision: "allow" },
        "mutate"
      )
    ).toStrictEqual({ decision: "ask" });
  });

  test("either side answers alone", () => {
    expect(
      resolveServiceDecision({ decision: "ask" }, undefined, "read")
    ).toStrictEqual({ decision: "ask" });
    expect(
      resolveServiceDecision(undefined, { decision: "ask" }, "read")
    ).toStrictEqual({ decision: "ask" });
    expect(
      resolveServiceDecision(undefined, undefined, "read")
    ).toBeUndefined();
  });
});

describe(effectivePolicy, () => {
  test("an attended run keeps the stored tier", () => {
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
