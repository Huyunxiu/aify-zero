import { describe, expect, test } from "vitest";

import { approvalPolicyTarget } from "../src/lib/approval-policy-target";

describe(approvalPolicyTarget, () => {
  test("writes to the session id when the session has one", () => {
    expect(
      approvalPolicyTarget({
        sessionId: "s-1",
        sessionKey: "k-1",
        rowSaved: false,
      })
    ).toBe("s-1");
  });

  test("writes to the new row once the home route saved it", () => {
    expect(
      approvalPolicyTarget({
        sessionId: undefined,
        sessionKey: "k-1",
        rowSaved: true,
      })
    ).toBe("k-1");
  });

  test("has nowhere to write before the row exists", () => {
    expect(
      approvalPolicyTarget({
        sessionId: undefined,
        sessionKey: "k-1",
        rowSaved: false,
      })
    ).toBeUndefined();
  });
});
