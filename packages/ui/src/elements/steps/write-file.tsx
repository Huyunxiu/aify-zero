import { FilePlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { summarizeTool } from "./summary";
import { ToolCardsStep } from "./tool-cards";
import type { StepPartOf, StepViewProps } from "./types";

export const writeFileSummary = (
  part: StepPartOf<"tool-write-file">
): ReactNode | undefined =>
  summarizeTool(part, ({ metadata }) => {
    if (!metadata) {
      return;
    }

    const action = metadata.created ? "created" : "updated";
    return metadata.lines > 0 ? `${action} · ${metadata.lines} lines` : action;
  });

/** A file a call created or rewrote in full. */
export const WriteFileStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-write-file">) => (
  <ToolCardsStep
    action="Create"
    detail={part.input?.path}
    duration={duration}
    icon={<FilePlusIcon />}
    onRespond={onRespond}
    part={part}
    status={status}
    summary={writeFileSummary(part)}
  />
);
