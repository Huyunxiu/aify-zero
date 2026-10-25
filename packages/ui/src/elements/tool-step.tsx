import type { AgentToolSet } from "@workspace/agent";
import {
  isAgentReasoningPart,
  isAgentStaticToolPart,
  isAgentTextPart,
  isAgentToolPart,
} from "@workspace/agent-client";
import type {
  AgentAssistantStep,
  AgentCompactionStep,
  AgentPart,
  AgentStaticToolPart,
  AgentToolPart,
  AgentTurnStatus,
} from "@workspace/agent-client";
import type { ReactNode } from "react";

/** A part as it is rendered, next to the step that owns it. */
export type StepRow = {
  part: AgentPart<AgentToolSet>;
  step: AgentAssistantStep<AgentToolSet> | AgentCompactionStep;
};

/**
 * The states a row can render in. Deliberately not the tool part's own `state`:
 * `output-available` covers both a success and a tool that reported failure
 * through `output.code`, and the row has to tell those apart.
 *
 * `aborted` is the third way a call can end without a result: the turn it
 * belonged to was stopped. It is not `failed` — nothing went wrong — and it is
 * certainly not `complete`.
 */
export type StepRowStatus =
  | "running"
  | "complete"
  | "failed"
  | "denied"
  | "aborted"
  | "approval";

/**
 * The two states whose row cannot be read off the state name alone: a held call
 * is `approval` when it is the user's turn, and an answered one is `running` or
 * `denied` depending on what the user said. Both are resolved in
 * `getRowStatus`; this is only here so the lookup table stays exhaustive over
 * the states that are a pure naming of the row.
 */
type ResolvedToolState = Exclude<
  AgentToolPart["state"],
  "approval-requested" | "approval-responded"
>;

/**
 * A lookup rather than a switch: the record's key type is every state it claims,
 * so a state added to the protocol fails to compile here — either because the
 * table is missing the new key, or because `getRowStatus` can no longer index
 * it — instead of falling through to a default.
 */
const TOOL_STATE_STATUS: Record<ResolvedToolState, StepRowStatus> = {
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
): StepRowStatus => {
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
 * The metadata of a `read-file` or `load-skill` call, which share one union.
 * Restated here rather than imported because the agent package keeps it
 * private; structural typing means a new member over there fails to compile
 * here, which is the drift check we want.
 */
type FileReadMetadata =
  | { type: "miss"; filepath: string }
  | {
      type: "directory";
      filepath: string;
      truncated: boolean;
      entries: string[];
      limit: number;
      offset: number;
      totalEntries: number;
    }
  | {
      type: "file";
      mime: string;
      text: string;
      filepath: string;
      truncated: boolean;
      limit: number;
      offset: number;
      totalLines?: number;
    }
  | { type: "attachments"; filepath: string; mime: string }
  | { type: "binary-file"; filepath: string; mime: string };

/**
 * Summarizes a file read. `totalLines` is optional, and absent exactly when the
 * byte cap cut the file off before its end was known — so a truncated read with
 * no total says `truncated` rather than inventing a number, and the known-total
 * case says how much of the file is missing without claiming which lines were
 * shown (the read may have been offset into the middle of the file).
 */
const summarizeFileRead = (
  metadata: FileReadMetadata | undefined
): string | undefined => {
  if (!metadata) {
    return undefined;
  }
  switch (metadata.type) {
    case "file": {
      if (metadata.totalLines === undefined) {
        return metadata.truncated ? "truncated" : undefined;
      }
      return metadata.truncated
        ? `${metadata.totalLines} lines · partial`
        : `${metadata.totalLines} lines`;
    }
    case "directory": {
      return metadata.truncated
        ? `${metadata.entries.length} of ${metadata.totalEntries} entries`
        : `${metadata.totalEntries} entries`;
    }
    case "miss": {
      return "not found";
    }
    case "attachments": {
      return metadata.mime;
    }
    case "binary-file": {
      return "binary file";
    }
    default: {
      return undefined;
    }
  }
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

/** The status facts both shell tools report. */
type ShellSummaryMetadata = {
  /** Absent on turns persisted before background execution existed. */
  kind?: "foreground" | "background";
  timeout?: boolean;
  aborted?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  truncated?: boolean;
};

/**
 * One summary for both shell dialects. A non-zero exit is reported here rather
 * than as a failed row: the tool treats it as an ordinary result, and so should
 * the chain. A truncation hint rides along because the model-facing body says
 * so too.
 */
const summarizeShell = (
  metadata: ShellSummaryMetadata | undefined
): string | undefined => {
  if (!metadata) {
    return undefined;
  }
  let summary: string | undefined;
  if (metadata.timeout) {
    summary = "timed out";
  } else if (metadata.aborted) {
    summary = "aborted";
  } else if (metadata.signal !== null && metadata.signal !== undefined) {
    summary = `killed by ${metadata.signal}`;
  } else if (
    metadata.exitCode !== null &&
    metadata.exitCode !== undefined &&
    metadata.exitCode !== 0
  ) {
    summary = `exit ${metadata.exitCode}`;
  }
  if (metadata.truncated === true) {
    return summary === undefined
      ? "output truncated"
      : `${summary} · output truncated`;
  }
  return summary;
};

/**
 * A short, honest note about what a tool achieved — `650 lines`, `+12 −4`,
 * `exit 1` — or undefined when there is nothing worth saying.
 *
 * Only a tool that finished successfully gets one: while a tool is running its
 * outcome is unknown, and on failure the row's `Failed` label already carries
 * the meaning, so a summary would only repeat it.
 *
 * Every metadata read is optional-chained. The field is required by the tool
 * types, but turns persisted before those tools carried metadata are already in
 * the database without it, and they have to render.
 */
export const getPartSummary = (
  part: AgentPart<AgentToolSet>
): ReactNode | undefined => {
  if (part.type === "compaction") {
    return part.record ? "context compacted" : undefined;
  }

  if (isAgentToolPart(part) && part.state === "approval-requested") {
    // The row's own status carries the waiting; the dialog is where the
    // decision is made, so the row only says that one is owed.
    if (part.approval.isAutomatic) {
      return undefined;
    }
    return part.type === "tool-questionnaire"
      ? "awaiting answers"
      : "awaiting approval";
  }

  if (part.type === "tool-questionnaire") {
    if (part.state === "approval-responded") {
      return part.approval.approved ? "answers submitted" : "declined";
    }
    if (part.state === "output-denied") {
      return "declined";
    }
  }

  // A `task` call is the one row worth reading before it has finished: its
  // label holds the description the model wrote, which does not say which
  // subagent is at work. Nothing else is summarized while it runs.
  if (part.type === "tool-task" && part.state === "input-available") {
    return part.input?.subagent_type;
  }

  if (!isAgentToolPart(part) || !isAgentStaticToolPart(part)) {
    return undefined;
  }
  if (part.state !== "output-available" || part.output.code !== "ok") {
    return undefined;
  }

  // Read the metadata per case, not once above: a single `const metadata =
  // part.output.metadata` widens to the union of every tool's metadata, and the
  // switch below can no longer narrow it.
  switch (part.type) {
    case "tool-read-file": {
      return summarizeFileRead(part.output.metadata);
    }

    case "tool-load-skill": {
      return part.input?.skill ?? summarizeFileRead(part.output.metadata);
    }

    case "tool-grep": {
      // `matchCount` is the number of *rendered output lines*, not matches: it
      // is capped by the limit, and with `context > 0` a match contributes its
      // surrounding lines too. So the label says lines, and says so louder when
      // a cap was hit, because then the real number is only a lower bound.
      const { metadata } = part.output;
      if (!metadata) {
        return undefined;
      }
      if (metadata.matchCount === 0) {
        return "no matches";
      }
      const count =
        metadata.truncatedByBytes || metadata.truncatedByLines
          ? `${metadata.matchCount}+`
          : `${metadata.matchCount}`;
      return (part.input?.context ?? 0) > 0
        ? `${count} lines (with context)`
        : `${count} matching lines`;
    }

    case "tool-glob": {
      // Same caveat as grep: `count` is capped by the limit.
      const { metadata } = part.output;
      if (!metadata) {
        return undefined;
      }
      if (metadata.count === 0) {
        return "no files";
      }
      return metadata.truncatedByBytes || metadata.truncatedByLines
        ? `${metadata.count}+ files`
        : `${metadata.count} files`;
    }

    case "tool-bash":
    case "tool-powershell": {
      return summarizeShell(part.output.metadata);
    }

    case "tool-job-output": {
      return part.output.metadata?.job.status;
    }

    case "tool-job-list": {
      const { metadata } = part.output;
      if (!metadata) {
        return undefined;
      }
      return `${metadata.count} jobs`;
    }

    case "tool-job-kill": {
      const { metadata } = part.output;
      if (!metadata) {
        return undefined;
      }
      return metadata.outcome === "cancellation-requested"
        ? "cancelling"
        : undefined;
    }

    case "tool-web-fetch": {
      const { metadata } = part.output;
      if (!metadata) {
        return undefined;
      }
      const label = metadata.title || metadata.url;
      return metadata.truncated ? `${label} (truncated)` : label;
    }

    case "tool-edit-file": {
      const { metadata } = part.output;
      if (!metadata) {
        return undefined;
      }
      return (
        <>
          <span className="text-green-600 tabular-nums">
            +{metadata.linesAdded}
          </span>
          <span className="text-destructive tabular-nums">
            {" −"}
            {metadata.linesRemoved}
          </span>
          {metadata.replacements > 1 && ` · ${metadata.replacements} blocks`}
        </>
      );
    }

    case "tool-write-file": {
      const { metadata } = part.output;
      if (!metadata) {
        return undefined;
      }
      const action = metadata.created ? "created" : "updated";
      return metadata.lines > 0
        ? `${action} · ${metadata.lines} lines`
        : action;
    }

    case "tool-delete-file": {
      const { metadata } = part.output;
      if (!metadata) {
        return undefined;
      }
      return metadata.kind === "directory"
        ? "directory deleted"
        : "file deleted";
    }

    case "tool-task": {
      // Which subagent ran, whether the call is done or only reporting from
      // part-way through. A subagent that ended badly comes back as
      // `code: "error"`, and the guard above has already left the row to say
      // that on its own.
      return part.input?.subagent_type;
    }

    case "tool-questionnaire": {
      const { metadata } = part.output;
      if (!metadata || metadata.status !== "submitted") {
        return undefined;
      }
      return `${metadata.answered}/${metadata.total} answered`;
    }

    default: {
      return undefined;
    }
  }
};

/**
 * The approval fields a row can show, whichever state holds them. Restated here
 * for the same reason as the metadata types above: the protocol keeps the shape
 * of its own `approval`, and a change to it should fail to compile here rather
 * than leave a panel blank.
 */
export type RowApproval = {
  id: string;
  approved?: boolean;
  descriptor?: unknown;
  requestReason?: string;
  isAutomatic?: boolean;
  signature?: string;
  inputSchemaInput?: unknown;
};

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
