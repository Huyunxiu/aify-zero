import type { AgentToolPart, AgentToolSet } from "@workspace/agent-client";
import type { ReactNode } from "react";

import type { AgentStepStatus } from "../../components/ai-elements/chain-of-turn";
import { ToolPanels } from "../tool-panels";
import { StepFrame, StepLabel, StepShell } from "./shell";
import type { ToolRespond } from "./types";

/**
 * A call whose body is the input and output cards, under one title.
 *
 * Six tools draw exactly this: a file read, a file written, a file deleted, a
 * content search, a path search, and a page fetched. They differ in the icon,
 * the noun the row uses, the one field that names the call, and the summary —
 * so the arrangement is declared once, and each view supplies those four things.
 *
 * It is a component and not a record because the views that do not fit it (an
 * edit with its diff, a task that selects a pane, a questionnaire with its form)
 * are arrangements, not data.
 */
export const ToolCardsStep = ({
  part,
  status,
  duration,
  onRespond,
  icon,
  action,
  detail,
  summary,
  outputLanguage,
}: {
  part: AgentToolPart<AgentToolSet>;
  status: AgentStepStatus;
  duration?: string;
  onRespond?: ToolRespond;
  icon: ReactNode;
  /** What the row and the frame title call this call: `Read`, `Grep`. */
  action: string;
  /** The field that names this particular call, such as the path it touched. */
  detail?: string;
  summary?: ReactNode;
  /** How to highlight the output; the view that knows what a tool answered says so. */
  outputLanguage?: string;
}) => (
  <StepShell
    approvalPart={part}
    body={
      <StepFrame title={action}>
        <ToolPanels
          onRespond={onRespond}
          outputLanguage={outputLanguage}
          part={part}
        />
      </StepFrame>
    }
    duration={duration}
    icon={icon}
    label={<StepLabel action={action} detail={detail} />}
    onRespond={onRespond}
    status={status}
    summary={summary}
  />
);
