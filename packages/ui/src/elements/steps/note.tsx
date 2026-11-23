import { TextIcon } from "lucide-react";

import { MarkdownStep } from "./markdown-step";
import type { StepViewProps } from "./types";

/**
 * A note the model wrote on its way to the answer.
 *
 * It is a step of the chain, not the turn's answer: the answer is the last text
 * of the turn, drawn below the chain.
 */
export const NoteStep = ({ part, status, duration }: StepViewProps<"text">) => (
  <MarkdownStep
    action="Note"
    duration={duration}
    icon={<TextIcon />}
    part={part}
    status={status}
  />
);
