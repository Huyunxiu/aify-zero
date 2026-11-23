import { FolderSearchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ToolPanels } from "../tool-panels";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { summarizeTool } from "./summary";
import type { StepPartOf, StepViewProps } from "./types";

export const globSummary = (
  part: StepPartOf<"tool-glob">
): ReactNode | undefined =>
  summarizeTool(part, ({ metadata }) => {
    // Same caveat as grep: `count` is capped by the limit.
    if (!metadata) {
      return;
    }
    if (metadata.count === 0) {
      return "no files";
    }
    return metadata.truncatedByBytes || metadata.truncatedByLines
      ? `${metadata.count}+ files`
      : `${metadata.count} files`;
  });

/** A path search: the pattern, and how many files matched. */
export const GlobStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-glob">) => (
  <StepShell
    approvalPart={part}
    body={
      <StepFrame title="Glob">
        <ToolPanels onRespond={onRespond} part={part} />
      </StepFrame>
    }
    duration={duration}
    icon={<FolderSearchIcon />}
    label={<StepLabel action="Glob" detail={part.input?.pattern} />}
    onRespond={onRespond}
    status={status}
    summary={globSummary(part)}
  />
);
