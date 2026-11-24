import { FilePlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ToolPanels } from "../tool-panels";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { summarizeTool } from "./summary";
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
  <StepShell
    approvalPart={part}
    body={
      <StepFrame title="Create">
        <ToolPanels onRespond={onRespond} part={part} />
      </StepFrame>
    }
    duration={duration}
    icon={<FilePlusIcon />}
    label={<StepLabel action="Create" detail={part.input?.path} />}
    onRespond={onRespond}
    status={status}
    summary={writeFileSummary(part)}
  />
);
