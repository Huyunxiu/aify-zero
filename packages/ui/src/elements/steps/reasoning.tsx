import { BrainIcon } from "lucide-react";

import { MarkdownStep } from "./markdown-step";
import type { StepViewProps } from "./types";

/** What the model thought before it acted. */
export const ReasoningStep = ({
  part,
  status,
  duration,
}: StepViewProps<"reasoning">) => (
  <MarkdownStep
    action="Reasoning"
    duration={duration}
    icon={<BrainIcon />}
    part={part}
    status={status}
  />
);
