import { EyeIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ToolPanels } from "../tool-panels";
import { outputLanguageOf, summarizeFileRead } from "./file-read";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { finishedOutput, pendingSummary } from "./summary";
import type { StepPartOf, StepViewProps } from "./types";

export const readFileSummary = (
  part: StepPartOf<"tool-read-file">
): ReactNode | undefined => {
  const pending = pendingSummary(part);
  if (pending !== undefined) {
    return pending;
  }
  return summarizeFileRead(finishedOutput(part)?.metadata);
};

/** A file the model read: what it was asked for, and what came back. */
export const ReadFileStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-read-file">) => (
  <StepShell
    approvalPart={part}
    body={
      <StepFrame title="Read">
        <ToolPanels
          onRespond={onRespond}
          outputLanguage={outputLanguageOf(part)}
          part={part}
        />
      </StepFrame>
    }
    duration={duration}
    icon={<EyeIcon />}
    label={<StepLabel action="Read" detail={part.input?.path} />}
    onRespond={onRespond}
    status={status}
    summary={readFileSummary(part)}
  />
);
