import { FolderSearchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { summarizeTool } from "./summary";
import { ToolCardsStep } from "./tool-cards";
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
  <ToolCardsStep
    action="Glob"
    detail={part.input?.pattern}
    duration={duration}
    icon={<FolderSearchIcon />}
    onRespond={onRespond}
    part={part}
    status={status}
    summary={globSummary(part)}
  />
);
