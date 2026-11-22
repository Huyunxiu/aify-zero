import { SearchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ToolPanels } from "../tool-panels";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { finishedOutput, pendingSummary } from "./summary";
import type { StepPartOf, StepViewProps } from "./types";

export const grepSummary = (
  part: StepPartOf<"tool-grep">
): ReactNode | undefined => {
  const pending = pendingSummary(part);
  if (pending !== undefined) {
    return pending;
  }
  // `matchCount` is the number of *rendered output lines*, not matches: it is
  // capped by the limit, and with `context > 0` a match contributes its
  // surrounding lines too. So the label says lines, and says so louder when a
  // cap was hit, because then the real number is only a lower bound.
  const metadata = finishedOutput(part)?.metadata;
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
};

/** A content search: the pattern, and how many lines it found. */
export const GrepStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-grep">) => (
  <StepShell
    approvalPart={part}
    body={
      <StepFrame title="Grep">
        <ToolPanels onRespond={onRespond} part={part} />
      </StepFrame>
    }
    duration={duration}
    icon={<SearchIcon />}
    label={<StepLabel action="Grep" detail={part.input?.pattern} />}
    onRespond={onRespond}
    status={status}
    summary={grepSummary(part)}
  />
);
