import type { ReactNode } from "react";

import type { AgentStepStatus } from "../../blocks/chain-of-turn";
import { RenderedSection } from "../tool-panels";
import { MarkdownBody } from "./markdown-body";
import { StepLabel, StepShell } from "./shell";

/** Max characters of the body's first line used as the row's detail. */
const DETAIL_MAX_LENGTH = 180;

/** The first non-empty line of a body: enough to name it, short enough to read. */
const firstLineOf = (text: string): string | undefined => {
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  if (!line) {
    return undefined;
  }

  return line.length > DETAIL_MAX_LENGTH
    ? `${line.slice(0, DETAIL_MAX_LENGTH)}…`
    : line;
};

/**
 * A step whose whole body is Markdown: a note, and the reasoning behind a call.
 *
 * They differ in their icon and the noun the row uses, and in nothing else, so
 * the arrangement is declared once and each names itself.
 */
export const MarkdownStep = ({
  part,
  status,
  duration,
  icon,
  action,
}: {
  part: { text: string };
  status: AgentStepStatus;
  duration?: string;
  icon: ReactNode;
  /** What the row calls this step: `Note`, `Reasoning`. */
  action: string;
}) => (
  <StepShell
    body={
      <RenderedSection copyValue={part.text} label={action}>
        <MarkdownBody text={part.text} />
      </RenderedSection>
    }
    duration={duration}
    icon={icon}
    label={<StepLabel action={action} detail={firstLineOf(part.text)} />}
    status={status}
  />
);
