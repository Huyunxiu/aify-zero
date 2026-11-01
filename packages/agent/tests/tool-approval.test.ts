import { logger } from "@workspace/shared/logger";
import { describe, expect, test, vi } from "vitest";

import type { ToolCallHookEvent } from "../src/hooks-manager.js";
import { resolveToolStartDecision } from "../src/hooks-manager.js";
import type {
  ToolApprovalDecision,
  ToolApprovalPattern,
} from "../src/tool-approval.js";
import { evaluateToolApproval } from "../src/tool-approval.js";

const DEFAULT_INPUT = { path: "notes.md" };

const request = (
  toolName = "write-file",
  input: unknown = DEFAULT_INPUT
): ToolCallHookEvent => ({
  sessionId: "session-1",
  turnId: "turn-1",
  stepId: "step-1",
  toolCallId: "call-1",
  toolName,
  input,
  messages: [],
});

/** 一次异步拒绝，用来证明函数可以返回 promise。 */
const asyncDeny: ToolApprovalPattern = () =>
  Promise.resolve({ decision: "deny", reason: "blocked" });

describe(evaluateToolApproval, () => {
  test("has no opinion without a pattern", async () => {
    await expect(
      evaluateToolApproval(undefined, request())
    ).resolves.toBeUndefined();
  });

  test("asks the pattern about the call and returns its decision", async () => {
    const pattern = vi.fn<(event: ToolCallHookEvent) => ToolApprovalDecision>(
      (event) =>
        event.toolName === "write-file" ? { decision: "ask" } : undefined
    );

    await expect(
      evaluateToolApproval(pattern, request())
    ).resolves.toStrictEqual({ decision: "ask" });
    expect(pattern).toHaveBeenCalledWith(request());
  });

  test("awaits an async pattern", async () => {
    await expect(
      evaluateToolApproval(asyncDeny, request())
    ).resolves.toStrictEqual({ decision: "deny", reason: "blocked" });
  });

  test("treats null as no opinion", async () => {
    await expect(
      evaluateToolApproval(() => null, request())
    ).resolves.toBeUndefined();
  });

  test("treats a pattern that throws as no opinion", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    try {
      await expect(
        evaluateToolApproval(() => {
          throw new Error("boom");
        }, request())
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe(resolveToolStartDecision, () => {
  test("abstains when nobody had an opinion", () => {
    expect(resolveToolStartDecision([])).toBeUndefined();
  });

  test("keeps the first refusal whatever else was said", () => {
    expect(
      resolveToolStartDecision([
        { decision: "allow" },
        { decision: "deny", reason: "blocked" },
        { decision: "ask" },
      ])
    ).toStrictEqual({ decision: "deny", reason: "blocked" });
  });

  test("an ask stands over an allow", () => {
    expect(
      resolveToolStartDecision([{ decision: "allow" }, { decision: "ask" }])
    ).toStrictEqual({ decision: "ask" });
  });

  test("an allow is the answer when nothing refused or asked", () => {
    expect(
      resolveToolStartDecision([{ decision: "allow" }, { decision: "allow" }])
    ).toStrictEqual({ decision: "allow" });
  });
});
