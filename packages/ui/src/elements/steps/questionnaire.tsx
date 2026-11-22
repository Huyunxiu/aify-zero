import { ListChecksIcon } from "lucide-react";
import type { ReactNode } from "react";

import { QuestionnaireCard, QuestionnaireSummary } from "../questionnaire";
import { ToolPartError } from "../tool-panels";
import { StepLabel, StepShell } from "./shell";
import { finishedOutput, pendingSummary } from "./summary";
import type { StepPartOf, StepViewProps } from "./types";

export const questionnaireSummary = (
  part: StepPartOf<"tool-questionnaire">
): ReactNode | undefined => {
  const pending = pendingSummary(part);
  if (pending !== undefined) {
    return pending;
  }
  if (part.state === "approval-responded") {
    return part.approval.approved ? "answers submitted" : "declined";
  }
  if (part.state === "output-denied") {
    return "declined";
  }

  const metadata = finishedOutput(part)?.metadata;
  if (metadata?.status !== "submitted") {
    return undefined;
  }

  return `${metadata.answered}/${metadata.total} answered`;
};

/**
 * A questionnaire the model put to the user.
 *
 * The form stands outside the step, where the answer is given: the step itself
 * shows what was asked and what came back. It takes the whole row back from the
 * shell for that second element.
 */
export const QuestionnaireStep = ({
  part,
  status,
  duration,
  onRespond,
  questionnairePlacement = "inline",
}: StepViewProps<"tool-questionnaire">) => (
  <>
    <StepShell
      approvalPart={part}
      body={
        <>
          <QuestionnaireSummary part={part} />
          <ToolPartError part={part} />
        </>
      }
      duration={duration}
      icon={<ListChecksIcon />}
      label={
        <StepLabel
          action="Questionnaire"
          detail={part.input?.title ?? part.input?.questions?.[0]?.prompt}
        />
      }
      onRespond={onRespond}
      status={status}
      summary={questionnaireSummary(part)}
    />
    {questionnairePlacement === "inline" && (
      <QuestionnaireCard onRespond={onRespond} part={part} />
    )}
  </>
);
