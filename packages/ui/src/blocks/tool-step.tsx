import {
  isAgentReasoningPart,
  isAgentStaticToolPart,
  isAgentTextPart,
  isAgentToolPart,
} from "@workspace/agent-client";
import type {
  AgentToolSet,
  AgentAssistantStep,
  AgentCompactionStep,
  AgentPart,
  AgentStaticToolPart,
  AgentToolPart,
  AgentTurnStatus,
} from "@workspace/agent-client";

import type { AgentStepStatus } from "../blocks/chain-of-turn";
import type { StepPart } from "./steps/types";

/** A part as it is rendered, next to the step that owns it. */
export type StepRow = {
  part: StepPart;
  step: AgentAssistantStep<AgentToolSet> | AgentCompactionStep;
};

/**
 * The two states whose row cannot be read off the state name alone: a held call
 * is `approval` when it is the user's turn, and an answered one is `running` or
 * `denied` depending on what the user said. Both are resolved in
 * `getPartStatus`; this is only here so the lookup table stays exhaustive over
 * the states that are a pure naming of the row.
 */
type ResolvedToolState = Exclude<
  AgentToolPart["state"],
  "approval-requested" | "approval-responded"
>;

/**
 * A lookup rather than a switch: the record's key type is every state it claims,
 * so a state added to the protocol fails to compile here — either because the
 * table is missing the new key, or because `getPartStatus` can no longer index
 * it — instead of falling through to a default.
 */
const TOOL_STATE_STATUS: Record<ResolvedToolState, AgentStepStatus> = {
  "input-streaming": "running",
  "input-available": "running",
  "output-available": "complete",
  "output-denied": "denied",
  "output-error": "failed",
};

/**
 * turn 已经落定的那几个状态——不会再有事件落到它上面。
 *
 * `streaming` 不算；`wait_review` 也不算：那一轮停在等用户回答，答完还有一段流
 * 接着跑，它手里的 preliminary 仍可能有后续。
 */
const TURN_SETTLED = new Set<AgentTurnStatus["status"]>([
  "done",
  "aborted",
  "error",
]);

export const getPartStatus = (
  part: AgentPart<AgentToolSet>,
  turnStatus?: AgentTurnStatus["status"]
): AgentStepStatus => {
  if (part.type === "compaction") {
    // The part exists from `compaction.start`; only the record makes it a
    // marker. Until then the row reports the summarization it is waiting on.
    return part.state === "streaming" ? "running" : "complete";
  }

  if (isAgentToolPart(part)) {
    if (part.state === "approval-requested") {
      // A call a policy approves on its own is not waiting on the user, so it
      // reads as the work it is about to be rather than as a question.
      return part.approval.isAutomatic ? "running" : "approval";
    }
    if (part.state === "approval-responded") {
      return part.approval.approved ? "running" : "denied";
    }
    // A tool that reports while it is still going — `task` does, so a client
    // can follow the subagent it started — is in `output-available` with
    // `preliminary` set. That is not the call's outcome: the row keeps running
    // until the report that is not preliminary arrives.
    //
    // 除非那个报告永远不会来了。turn 已经落定（被停、出错，或者流就那么断了）
    // 而 part 还停在 preliminary，说明它手里那份就是最后一份——进程被杀时落库
    // 的就是这个样子。再转圈就是骗人。
    if (part.state === "output-available" && part.preliminary) {
      return turnStatus && TURN_SETTLED.has(turnStatus) ? "aborted" : "running";
    }
    // 子 agent 被中断：父会话一停，signal 传导下去把它一起停了，`task` 于是
    // 拿着一份"没有报告"回来。这不是失败——`code: "error"` 在这里说的是"没拿到
    // 结果"，不是"子 agent 出错了"。
    if (
      part.type === "tool-task" &&
      part.state === "output-available" &&
      part.output.metadata?.status === "aborted"
    ) {
      return "aborted";
    }
    // A tool that ran and reported `code: "error"` is still in
    // `output-available` — glob and read-file do this for a bad path. The row
    // has to read the code, or a failure renders as a success.
    if (
      part.state === "output-available" &&
      isAgentStaticToolPart(part) &&
      part.output.code === "error"
    ) {
      return "failed";
    }
    return TOOL_STATE_STATUS[part.state];
  }

  if (part.type === "text" || part.type === "reasoning") {
    return part.state === "streaming" ? "running" : "complete";
  }

  return "complete";
};

/**
 * The text a call ends with, and what that end is called.
 *
 * A refusal is not a failure — "ERROR" would blame a tool that never ran. A call
 * the user answered carries the approval, so it was declined; one that no
 * approval reached was refused before it started.
 */
export const getPartError = (
  part: AgentToolPart
): { label: string; text: string } | undefined => {
  if (!part.errorText) {
    return undefined;
  }

  if (part.state === "output-denied") {
    return {
      label: part.approval ? "Declined" : "Refused",
      text: part.errorText,
    };
  }

  if (part.state === "output-error") {
    return { label: "Error", text: part.errorText };
  }

  return undefined;
};

/** The three tools whose input names a file they changed. */
type FileEditingPart = Extract<
  AgentStaticToolPart<AgentToolSet>,
  { type: "tool-edit-file" | "tool-write-file" | "tool-delete-file" }
>;

const isFileEditingPart = (
  part: AgentStaticToolPart<AgentToolSet>
): part is FileEditingPart =>
  part.type === "tool-edit-file" ||
  part.type === "tool-write-file" ||
  part.type === "tool-delete-file";

/** The path a file-editing tool acted on, or undefined for every other tool. */
const editedPath = (
  part: AgentStaticToolPart<AgentToolSet>
): string | undefined =>
  isFileEditingPart(part) ? part.input?.path : undefined;

/**
 * How long a row took, in milliseconds, or undefined when that is not known.
 *
 * A tool row uses the runtime's own `toolExecutionMs`, keyed by tool call id,
 * which times the call's execution and nothing else.
 *
 * There is deliberately no fallback to the step's `createdAt`/`completedAt`
 * span. That span also covers the model writing the call, so it overstates
 * every tool — more so the more the step held — and a wrong number in a column
 * that reads like a measurement is worse than an empty one. Not every call has
 * an entry (an invalid call, and one whose approval was denied, are never
 * executed), and a running one has none because `performance` only lands when
 * the step finishes; both are left blank.
 *
 * A text, reasoning, or compaction row is timed by the part itself, whose span
 * is the whole of what it measures: it starts with the part and ends with the
 * stream (for compaction, with the summary). A part the stream never ended has
 * no `completedAt` and is left blank — manual compaction markers never stream,
 * and a marker from a transcript written before parts carried times has no
 * usable start — as is one whose `createdAt` is not a number: a `NaN` in the
 * column is the wrong number this function exists to refuse.
 */
export const getPartDurationMs = (
  part: AgentPart<AgentToolSet>,
  step: StepRow["step"]
): number | undefined => {
  if (isAgentToolPart(part)) {
    return step.metadata?.performance?.toolExecutionMs?.[part.toolCallId];
  }

  if (
    part.type === "compaction" ||
    isAgentTextPart(part) ||
    isAgentReasoningPart(part)
  ) {
    if (part.completedAt === undefined || !Number.isFinite(part.createdAt)) {
      return undefined;
    }

    return part.completedAt - part.createdAt;
  }

  return undefined;
};

/** A compact duration: `850ms`, `4.2s`, `42s`, `3m 07s`, `1h 12m`. */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 10) {
    // A whole number of seconds has no tenths worth showing — a live timer
    // would otherwise read `3.0s`, `4.0s`, `5.0s`.
    const tenths = seconds.toFixed(1);
    return tenths.endsWith(".0") ? `${Math.floor(seconds)}s` : `${tenths}s`;
  }
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  if (minutes < 60) {
    return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  }

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};

/**
 * What a whole turn did, in the form `5 tools · 3 files changed · 1 failed`,
 * or undefined for a turn that called no tools.
 *
 * Files are counted by distinct path, so editing one file five times reads as
 * one file changed.
 */
export const summarizeTurn = (rows: StepRow[]): string | undefined => {
  const toolParts = rows
    .map((row) => row.part)
    .filter((part) => isAgentToolPart(part));
  if (toolParts.length === 0) {
    return undefined;
  }

  const changedFiles = new Set<string>();
  for (const part of toolParts) {
    if (!isAgentStaticToolPart(part)) {
      continue;
    }
    const path = editedPath(part);
    if (path !== undefined) {
      changedFiles.add(path);
    }
  }

  const failed = rows.filter((row) => {
    const status = getPartStatus(row.part);
    return status === "failed" || status === "denied";
  }).length;

  const awaiting = rows.filter(
    (row) => getPartStatus(row.part) === "approval"
  ).length;

  const summary = [
    `${toolParts.length} ${toolParts.length === 1 ? "tool" : "tools"}`,
  ];
  if (changedFiles.size > 0) {
    summary.push(
      `${changedFiles.size} ${changedFiles.size === 1 ? "file" : "files"} changed`
    );
  }
  if (awaiting > 0) {
    summary.push(`${awaiting} awaiting approval`);
  }
  if (failed > 0) {
    summary.push(`${failed} failed`);
  }

  return summary.join(" · ");
};
