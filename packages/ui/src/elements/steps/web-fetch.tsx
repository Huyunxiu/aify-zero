import { GlobeIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ToolPanels } from "../tool-panels";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { finishedOutput, pendingSummary } from "./summary";
import type { StepPartOf, StepViewProps } from "./types";

export const webFetchSummary = (
  part: StepPartOf<"tool-web-fetch">
): ReactNode | undefined => {
  const pending = pendingSummary(part);
  if (pending !== undefined) {
    return pending;
  }
  const metadata = finishedOutput(part)?.metadata;
  if (!metadata) {
    return undefined;
  }

  const label = metadata.title || metadata.url;
  return metadata.truncated ? `${label} (truncated)` : label;
};

/** A page the model fetched: the URL it asked for, and what the page calls itself. */
export const WebFetchStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-web-fetch">) => (
  <StepShell
    approvalPart={part}
    body={
      <StepFrame title="Fetch">
        <ToolPanels onRespond={onRespond} part={part} />
      </StepFrame>
    }
    duration={duration}
    icon={<GlobeIcon />}
    label={<StepLabel action="Fetch" detail={part.input?.url} />}
    onRespond={onRespond}
    status={status}
    summary={webFetchSummary(part)}
  />
);
