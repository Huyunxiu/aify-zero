import type { AgentToolPart, AgentToolSet } from "@workspace/agent-client";
import type { ReactNode } from "react";

import {
  AgentActivityApproval,
  AgentStep,
  AgentStepContent,
  AgentStepDescription,
  AgentStepIcon,
  AgentStepRow,
  AgentStepTitle,
  AgentStepTrigger,
} from "../../components/ai-elements/chain-of-turn";
import type { AgentStepStatus } from "../../components/ai-elements/chain-of-turn";
import { Frame, FrameHeader, FrameTitle } from "../../components/frame";
import type { ToolRespond } from "./types";

/**
 * One step of the chain: the row that reads it, the body behind it, and the
 * approval strip under it.
 *
 * It is the one authority for that arrangement. A view supplies what is its
 * own — the icon, the label, the summary, the body — and takes the whole row
 * back only where the arrangement differs: a `task` that selected the pane
 * beside the transcript, and a questionnaire that puts its form outside the
 * step.
 */
export type StepShellProps = {
  status: AgentStepStatus;
  duration?: string;
  /** The leading icon. It gives way to the arrow on hover. */
  icon: ReactNode;
  /** What the row says, usually a `StepLabel`. */
  label: ReactNode;
  /** A short note on what the step achieved, beside the label. */
  summary?: ReactNode;
  /** What the dialog shows. */
  body: ReactNode;
  /**
   * The call whose approval strip sits under the row. Absent for a step nothing
   * can be held on, such as a note or a compaction marker.
   */
  approvalPart?: AgentToolPart<AgentToolSet>;
  onRespond?: ToolRespond;
};

export const StepShell = ({
  status,
  duration,
  icon,
  label,
  summary,
  body,
  approvalPart,
  onRespond,
}: StepShellProps) => (
  <>
    <AgentStep>
      <AgentStepTrigger>
        <AgentStepRow duration={duration} status={status}>
          <AgentStepIcon>{icon}</AgentStepIcon>
          <AgentStepTitle>{label}</AgentStepTitle>
          {summary && <AgentStepDescription>{summary}</AgentStepDescription>}
        </AgentStepRow>
      </AgentStepTrigger>
      <AgentStepContent>{body}</AgentStepContent>
    </AgentStep>
    {approvalPart === undefined ? null : (
      <AgentActivityApproval
        part={approvalPart}
        onRespondToolApproval={onRespond}
      />
    )}
  </>
);

/**
 * What the row says, in the two forms every row uses: an action, and — when
 * there is one — the detail that names this particular call.
 */
export const StepLabel = ({
  action,
  detail,
}: {
  action: string;
  detail?: string;
}) => {
  if (detail) {
    return (
      <>
        <span className="text-foreground font-medium">{action}</span>
        <span className="ml-1 truncate">{detail}</span>
      </>
    );
  }

  return <span className="text-foreground font-medium">{action}</span>;
};

/**
 * The frame a tool's body sits in: no surface of its own, because the cards
 * inside it are the surface.
 *
 * `title` is the frame's header. A body without one — the jobs list — leaves it
 * out.
 */
export const StepFrame = ({
  title,
  children,
}: {
  title?: ReactNode;
  children: ReactNode;
}) => (
  <Frame
    className="bg-transparent shadow-none"
    overflowBehavior="scroll"
    variant="default"
  >
    {title === undefined ? null : (
      <FrameHeader className="px-3">
        <FrameTitle>{title}</FrameTitle>
      </FrameHeader>
    )}
    {children}
  </Frame>
);
