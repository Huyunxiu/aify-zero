import { Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { summarizeTool } from "./summary";
import { ToolCardsStep } from "./tool-cards";
import type { StepPartOf, StepViewProps } from "./types";

export const deleteFileSummary = (
  part: StepPartOf<"tool-delete-file">
): ReactNode | undefined =>
  summarizeTool(part, ({ metadata }) => {
    if (!metadata) {
      return;
    }

    return metadata.kind === "directory" ? "directory deleted" : "file deleted";
  });

/** A path a call removed, file or directory. */
export const DeleteFileStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-delete-file">) => (
  <ToolCardsStep
    action="Delete"
    detail={part.input?.path}
    duration={duration}
    icon={<Trash2Icon />}
    onRespond={onRespond}
    part={part}
    status={status}
    summary={deleteFileSummary(part)}
  />
);
