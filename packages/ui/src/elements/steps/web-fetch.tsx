import { GlobeIcon } from "lucide-react";
import type { ReactNode } from "react";

import { summarizeTool } from "./summary";
import { ToolCardsStep } from "./tool-cards";
import type { StepPartOf, StepViewProps } from "./types";

export const webFetchSummary = (
  part: StepPartOf<"tool-web-fetch">
): ReactNode | undefined =>
  summarizeTool(part, ({ metadata }) => {
    if (!metadata) {
      return;
    }

    const label = metadata.title || metadata.url;
    return metadata.truncated ? `${label} (truncated)` : label;
  });

/** A page the model fetched: the URL it asked for, and what the page calls itself. */
export const WebFetchStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-web-fetch">) => (
  <ToolCardsStep
    action="Fetch"
    detail={part.input?.url}
    duration={duration}
    icon={<GlobeIcon />}
    onRespond={onRespond}
    part={part}
    status={status}
    summary={webFetchSummary(part)}
  />
);
