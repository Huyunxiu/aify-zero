import { Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { ToolPanels } from "../tool-panels";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { finishedOutput, pendingSummary } from "./summary";
import type { StepPartOf, StepViewProps } from "./types";

export const deleteFileSummary = (
  part: StepPartOf<"tool-delete-file">
): ReactNode | undefined => {
  const pending = pendingSummary(part);
  if (pending !== undefined) {
    return pending;
  }
  const metadata = finishedOutput(part)?.metadata;
  if (!metadata) {
    return undefined;
  }

  return metadata.kind === "directory" ? "directory deleted" : "file deleted";
};

/** A path a call removed, file or directory. */
export const DeleteFileStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-delete-file">) => (
  <StepShell
    approvalPart={part}
    body={
      <StepFrame title="Delete">
        <ToolPanels onRespond={onRespond} part={part} />
      </StepFrame>
    }
    duration={duration}
    icon={<Trash2Icon />}
    label={<StepLabel action="Delete" detail={part.input?.path} />}
    onRespond={onRespond}
    status={status}
    summary={deleteFileSummary(part)}
  />
);
