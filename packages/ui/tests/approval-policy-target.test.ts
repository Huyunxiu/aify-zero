import { describe, expect, test } from "vitest";

import { approvalPolicyTarget } from "../src/lib/approval-policy-target";

describe(approvalPolicyTarget, () => {
  test("会话已经有 id 时写到它", () => {
    expect(
      approvalPolicyTarget({
        sessionId: "s-1",
        sessionKey: "k-1",
        rowSaved: false,
      })
    ).toBe("s-1");
  });

  test("首页路由落库之后写到刚建出来的那一行", () => {
    expect(
      approvalPolicyTarget({
        sessionId: undefined,
        sessionKey: "k-1",
        rowSaved: true,
      })
    ).toBe("k-1");
  });

  test("行还没建出来时没有可写的地方", () => {
    expect(
      approvalPolicyTarget({
        sessionId: undefined,
        sessionKey: "k-1",
        rowSaved: false,
      })
    ).toBeUndefined();
  });
});
