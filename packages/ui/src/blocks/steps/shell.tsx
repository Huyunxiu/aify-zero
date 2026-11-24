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
} from "../../blocks/chain-of-turn";
import type { AgentStepStatus } from "../../blocks/chain-of-turn";
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
 * out. The header is the only thing that says which step a full-screen dialog
 * belongs to, so it stays a bar of its own rather than moving into the cards.
 */
export const StepFrame = ({
  title,
  children,
}: {
  title?: ReactNode;
  children: ReactNode;
}) => (
  <div className="relative flex flex-col overflow-hidden rounded-[calc(var(--radius-xl)-2px)]">
    {title === undefined ? null : (
      <div className="mb-2 flex h-10 shrink-0 items-center gap-2.5 rounded-lg bg-muted px-3">
        <div className="font-medium text-sm text-accent-foreground">
          {title}
        </div>
      </div>
    )}
    {children}
  </div>
);
