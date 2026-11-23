import { ListChecksIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ToolPartError, ToolSection } from "../tool-panels";
import { StepFrame, StepShell } from "./shell";
import { summarizeTool } from "./summary";
import type { StepPartOf, StepViewPropsOf } from "./types";

type JobPart = StepPartOf<
  "tool-job-output" | "tool-job-list" | "tool-job-kill"
>;

/** What the row calls this call: the list, or the job it names. */
const jobLabel = (part: JobPart): string => {
  if (part.type === "tool-job-list") {
    return "Background jobs";
  }

  const action = part.type === "tool-job-kill" ? "Kill job" : "Read job";
  return `${action} ${part.input?.jobId ?? ""}`;
};

export const jobsSummary = (part: JobPart): ReactNode | undefined => {
  if (part.type === "tool-job-output") {
    return summarizeTool(part, ({ metadata }) => metadata?.job.status);
  }
  if (part.type === "tool-job-list") {
    return summarizeTool(part, ({ metadata }) =>
      metadata ? `${metadata.count} jobs` : undefined
    );
  }

  return summarizeTool(part, ({ metadata }) =>
    metadata?.outcome === "cancellation-requested" ? "cancelling" : undefined
  );
};

/**
 * The three background-job tools: start nothing, read what a job printed, list
 * the live ones, and cancel one.
 *
 * They share one body — a plain output block, not the input and output cards of
 * a call that touches the workspace — and differ in the noun the row uses.
 */
export const JobsStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewPropsOf<"tool-job-output" | "tool-job-list" | "tool-job-kill">) => (
  <StepShell
    approvalPart={part}
    body={
      <StepFrame>
        <div className="flex flex-col gap-1.5 p-1.5">
          <ToolSection
            label="Output"
            language="text"
            value={part.output?.output ?? ""}
          />
          <ToolPartError part={part} />
        </div>
      </StepFrame>
    }
    duration={duration}
    icon={<ListChecksIcon />}
    label={jobLabel(part)}
    onRespond={onRespond}
    status={status}
    summary={jobsSummary(part)}
  />
);
