import { SquareTerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ToolPanels } from "../tool-panels";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { summarizeTool } from "./summary";
import type { StepPartOf, StepViewPropsOf } from "./types";

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

type ShellPart = StepPartOf<"tool-bash" | "tool-powershell">;

export const shellSummary = (part: ShellPart): ReactNode | undefined =>
  summarizeTool(part, ({ metadata }) => summarizeShell(metadata));

/**
 * A command the model ran: `Bash` and `PowerShell`.
 *
 * The two differ in the noun the row uses and in nothing else, so one view
 * serves both names.
 */
export const ShellToolStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewPropsOf<"tool-bash" | "tool-powershell">) => {
  const action = part.type === "tool-powershell" ? "PowerShell" : "Bash";
  const label = <StepLabel action={action} detail={part.input?.description} />;

  return (
    <StepShell
      approvalPart={part}
      body={
        <StepFrame title={label}>
          <ToolPanels onRespond={onRespond} part={part} />
        </StepFrame>
      }
      duration={duration}
      icon={<SquareTerminalIcon />}
      label={label}
      onRespond={onRespond}
      status={status}
      summary={shellSummary(part)}
    />
  );
};
