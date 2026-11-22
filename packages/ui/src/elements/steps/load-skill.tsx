import { SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ToolPanels } from "../tool-panels";
import { summarizeFileRead } from "./file-read";
import { MarkdownBody } from "./markdown-body";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { finishedOutput, pendingSummary } from "./summary";
import type { StepPartOf, StepViewProps } from "./types";

export const loadSkillSummary = (
  part: StepPartOf<"tool-load-skill">
): ReactNode | undefined => {
  const pending = pendingSummary(part);
  if (pending !== undefined) {
    return pending;
  }
  const output = finishedOutput(part);
  if (!output) {
    return undefined;
  }

  return part.input?.skill ?? summarizeFileRead(output.metadata);
};

/**
 * A skill the model loaded into context.
 *
 * Its answer is the skill's own prose, so it is drawn as Markdown rather than
 * as a code block.
 */
export const LoadSkillStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-load-skill">) => (
  <StepShell
    approvalPart={part}
    body={
      <StepFrame title={<>Load skill {part.input?.skill}</>}>
        <ToolPanels
          onRespond={onRespond}
          part={part}
          renderOutput={(text) => <MarkdownBody text={text} />}
        />
      </StepFrame>
    }
    duration={duration}
    icon={<SparklesIcon />}
    label={<StepLabel action="Load skill" detail={part.input?.skill} />}
    onRespond={onRespond}
    status={status}
    summary={loadSkillSummary(part)}
  />
);
