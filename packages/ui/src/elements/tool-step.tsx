import type { AgentToolSet } from "@workspace/agent";
import {
  isAgentStaticToolPart,
  isAgentToolPart,
} from "@workspace/agent-client";
import type {
  AgentAssistantStep,
  AgentCompactionStep,
  AgentDynamicToolPart,
  AgentPart,
  AgentToolPart,
} from "@workspace/agent-client";
import type { ReactNode } from "react";

/**
 * Display logic for one row of a turn's step chain: what state the row is in,
 * what it achieved, and how long it took.
 *
 * Types are imported, never values, so this module stays a pure function of its
 * input: nothing here reaches for `ai` or the turn builder, and every export can
 * be covered by the Node test runner.
 */

type ToolPart = AgentToolPart<AgentToolSet> | AgentDynamicToolPart;

/** A part as it is rendered, next to the step that owns it. */
export type StepRow = {
  part: AgentPart<AgentToolSet>;
  step: AgentAssistantStep<AgentToolSet> | AgentCompactionStep;
};

/**
 * The four states a row can render in. Deliberately not the tool part's own
 * `state`: `output-available` covers both a success and a tool that reported
 * failure through `output.code`, and the row has to tell those apart.
 */
export type StepRowStatus = "running" | "complete" | "failed" | "denied";

/**
 * A lookup rather than a switch: the record's key type is the whole union, so
 * a state added to the protocol fails to compile here instead of falling
 * through to a default.
 */
const TOOL_STATE_STATUS: Record<ToolPart["state"], StepRowStatus> = {
  "input-streaming": "running",
  "input-available": "running",
  "output-available": "complete",
  "output-denied": "denied",
  "output-error": "failed",
};

export const getRowStatus = (part: AgentPart<AgentToolSet>): StepRowStatus => {
  if (isAgentToolPart(part)) {
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
  AgentToolPart<AgentToolSet>,
  { type: "tool-edit-file" | "tool-write-file" | "tool-delete-file" }
>;

const isFileEditingPart = (
  part: AgentToolPart<AgentToolSet>
): part is FileEditingPart =>
  part.type === "tool-edit-file" ||
  part.type === "tool-write-file" ||
  part.type === "tool-delete-file";

/** The path a file-editing tool acted on, or undefined for every other tool. */
const editedPath = (part: AgentToolPart<AgentToolSet>): string | undefined =>
  isFileEditingPart(part) ? part.input?.path : undefined;

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
export const getRowSummary = (
  part: AgentPart<AgentToolSet>
): ReactNode | undefined => {
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

    case "tool-bash": {
      // A nonzero exit is reported here rather than as a failed row: the tool
      // treats it as an ordinary result, and so should the chain.
      const { metadata } = part.output;
      if (metadata?.timeout) {
        return "timed out";
      }
      if (metadata?.aborted) {
        return "aborted";
      }
      const exitCode = metadata?.exitCode;
      return exitCode !== null && exitCode !== undefined && exitCode !== 0
        ? `exit ${exitCode}`
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
          {metadata.replacements > 1 && ` · ${metadata.replacements}×`}
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

    default: {
      return undefined;
    }
  }
};

/**
 * How long a tool call took, in milliseconds, or undefined when that is not
 * known.
 *
 * The only figure used is the runtime's own `toolExecutionMs`, keyed by tool
 * call id, which times the call's execution and nothing else.
 *
 * There is deliberately no fallback to the step's `createdAt`/`completedAt`
 * span. That span also covers the model writing the call, so it overstates
 * every tool — more so the more the step held — and a wrong number in a column
 * that reads like a measurement is worse than an empty one. Not every call has
 * an entry (an invalid call, and one whose approval was denied, are never
 * executed), and a running one has none because `performance` only lands when
 * the step finishes; both are left blank.
 */
export const getToolDurationMs = (
  part: AgentPart<AgentToolSet>,
  step: StepRow["step"]
): number | undefined => {
  if (!isAgentToolPart(part)) {
    return undefined;
  }

  return step.performance?.toolExecutionMs?.[part.toolCallId];
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
export const summarizeTurnRows = (rows: StepRow[]): string | undefined => {
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
    const status = getRowStatus(row.part);
    return status === "failed" || status === "denied";
  }).length;

  const summary = [
    `${toolParts.length} ${toolParts.length === 1 ? "tool" : "tools"}`,
  ];
  if (changedFiles.size > 0) {
    summary.push(
      `${changedFiles.size} ${changedFiles.size === 1 ? "file" : "files"} changed`
    );
  }
  if (failed > 0) {
    summary.push(`${failed} failed`);
  }

  return summary.join(" · ");
};
