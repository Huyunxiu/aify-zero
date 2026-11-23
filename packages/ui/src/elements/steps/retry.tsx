import { RotateCwIcon } from "lucide-react";

import { RenderedSection } from "../tool-panels";
import { MarkdownBody } from "./markdown-body";
import { StepLabel, StepShell } from "./shell";
import type { StepViewProps } from "./types";

/**
 * A retry that already happened, drawn where it happened: a failed step leaves
 * no record of its own, so this row is the explanation for the wait that
 * followed it.
 */
export const RetryStep = ({
  part,
  status,
  duration,
}: StepViewProps<"retry">) => (
  <StepShell
    body={
      <RenderedSection label="Reason">
        <MarkdownBody text={part.reason} />
      </RenderedSection>
    }
    duration={duration}
    icon={<RotateCwIcon />}
    label={
      <StepLabel action="Retry" detail={`${part.index}/${part.maxRetries}`} />
    }
    status={status}
    summary={part.reason || undefined}
  />
);
