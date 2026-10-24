import type { AgentToolSet, QuestionnaireToolInput } from "@workspace/agent";
import {
  createQuestionnaireApprovalData,
  questionnaireAllowsOther,
  readQuestionnaireApprovalData,
} from "@workspace/agent-client";
import type {
  AgentStaticToolPart,
  QuestionnaireAnswers,
} from "@workspace/agent-client";
import * as React from "react";

import type { ToolApprovalAnswer } from "../components/ai-elements/chain-of-turn";
import { Button } from "../components/button";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../components/frame";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "../components/questionnaire";

type QuestionnairePart = Extract<
  AgentStaticToolPart<AgentToolSet>,
  { type: "tool-questionnaire" }
>;

type PendingQuestionnairePart = Extract<
  QuestionnairePart,
  { state: "approval-requested" }
>;

type QuestionnaireQuestion = QuestionnaireToolInput["questions"][number];

type QuestionnaireCardProps = {
  part: QuestionnairePart;
  onRespond?: (
    approvalId: string,
    approved: boolean,
    answer?: ToolApprovalAnswer
  ) => void;
};

type QuestionnaireSummaryProps = {
  part: QuestionnairePart;
};

const DECLINED_REASON = "The user declined to answer the questionnaire.";

const readQuestions = (part: QuestionnairePart): QuestionnaireQuestion[] => {
  const questions = part.input?.questions;

  if (!Array.isArray(questions)) {
    return [];
  }

  return questions.filter(
    (question) =>
      typeof question === "object" &&
      question !== null &&
      typeof question.id === "string" &&
      typeof question.prompt === "string"
  ) as QuestionnaireQuestion[];
};

const answerLabel = (question: QuestionnaireQuestion, value: string): string =>
  question.choices?.find((choice) => choice.value === value)?.label ?? value;

const isDeclined = (part: QuestionnairePart): boolean =>
  part.state === "output-denied" ||
  (part.state === "approval-responded" && !part.approval.approved);

const readAnswers = (
  part: QuestionnairePart
): QuestionnaireAnswers | undefined => {
  if (part.state === "output-available" && part.output.metadata?.answers) {
    return part.output.metadata.answers;
  }

  return readQuestionnaireApprovalData(part.approval?.data);
};

const QuestionnaireForm = ({
  part,
  onRespond,
}: {
  part: PendingQuestionnairePart;
  onRespond: NonNullable<QuestionnaireCardProps["onRespond"]>;
}) => {
  const submittedRef = React.useRef(false);
  const { questions } = part.input;

  const handleSubmit = (event: React.SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (submittedRef.current) {
      return;
    }

    submittedRef.current = true;

    const formData = new FormData(event.currentTarget);
    const answers: QuestionnaireAnswers = {};

    for (const question of questions) {
      answers[question.id] = formData
        .getAll(question.id)
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    }

    onRespond(part.approval.id, true, {
      data: createQuestionnaireApprovalData(answers),
    });
  };

  const handleDecline = (): void => {
    if (submittedRef.current) {
      return;
    }

    submittedRef.current = true;
    onRespond(part.approval.id, false, { reason: DECLINED_REASON });
  };

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="truncate text-sm font-medium">
            {part.input.title ?? "Questionnaire"}
          </div>
          {part.input.description && (
            <p className="text-sm text-pretty text-muted-foreground">
              {part.input.description}
            </p>
          )}
        </div>
        <Button onClick={handleDecline} size="sm" type="button" variant="ghost">
          Decline
        </Button>
      </div>

      <Questionnaire className="gap-3" onSubmit={handleSubmit}>
        <QuestionnaireProgress />
        {questions.map((question) => (
          <QuestionnaireItem
            key={question.id}
            multiple={question.multiple}
            name={question.id}
            required={question.required}
          >
            <QuestionnaireTitle>{question.prompt}</QuestionnaireTitle>
            {question.description && (
              <QuestionnaireDescription>
                {question.description}
              </QuestionnaireDescription>
            )}
            <QuestionnaireChoices>
              {question.choices?.map((choice) => (
                <QuestionnaireChoice key={choice.value} value={choice.value}>
                  <span className="font-medium">{choice.label}</span>
                  {choice.description && (
                    <QuestionnaireChoiceDescription>
                      {choice.description}
                    </QuestionnaireChoiceDescription>
                  )}
                </QuestionnaireChoice>
              ))}
              {questionnaireAllowsOther(question) && (
                <QuestionnaireInput
                  aria-label="Other answer"
                  placeholder={
                    question.choices?.length
                      ? "Other answer…"
                      : "Type your answer…"
                  }
                />
              )}
            </QuestionnaireChoices>
            <QuestionnaireError />
          </QuestionnaireItem>
        ))}
        <QuestionnaireActions>
          <QuestionnairePrevious>Previous</QuestionnairePrevious>
          <QuestionnaireSkip>Skip</QuestionnaireSkip>
          <QuestionnaireNext>Next</QuestionnaireNext>
          <QuestionnaireSubmit>Submit answers</QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </>
  );
};

/**
 * The form a held questionnaire puts to the user, in the same card position as
 * the generic approval panel.
 *
 * It only exists while the call is waiting: submitting or declining answers the
 * call on screen straight away, and the resumed stream is what reports the
 * result. A read-only transcript has no one to answer, so it gets no form.
 */
export const QuestionnaireCard = ({
  part,
  onRespond,
}: QuestionnaireCardProps) => {
  if (
    part.state !== "approval-requested" ||
    part.approval.isAutomatic ||
    !onRespond ||
    part.input.questions.length === 0
  ) {
    return null;
  }

  return (
    <div className="pl-6 pb-0.5 pr-0.5">
      <div className="relative flex flex-col gap-3 overflow-hidden rounded-[calc(var(--radius-xl)-2px)] bg-background p-3 shadow-2xs">
        <QuestionnaireForm onRespond={onRespond} part={part} />
      </div>
    </div>
  );
};

/**
 * The questionnaire as it reads in the step's own dialog: the questions, and
 * whatever the answer or the stream has reported so far.
 */
export const QuestionnaireSummary = ({ part }: QuestionnaireSummaryProps) => {
  const questions = readQuestions(part);
  const answers = readAnswers(part);
  const declined = isDeclined(part);

  return (
    <Frame variant="default" overflowBehavior="scroll">
      <FrameHeader>
        <FrameTitle>{part.input?.title ?? "Questionnaire"}</FrameTitle>
      </FrameHeader>
      <FramePanel>
        <div className="flex flex-col gap-4">
          {part.input?.description && (
            <p className="text-sm text-pretty text-muted-foreground">
              {part.input.description}
            </p>
          )}
          {questions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The questionnaire has no questions yet.
            </p>
          ) : (
            <ol className="flex flex-col gap-3">
              {questions.map((question, index) => {
                const values = answers?.[question.id] ?? [];
                return (
                  <li key={question.id} className="flex flex-col gap-1">
                    <div className="text-sm font-medium">
                      {index + 1}. {question.prompt}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {values.length > 0
                        ? values
                            .map((value) => answerLabel(question, value))
                            .join(", ")
                        : declined
                          ? "Declined"
                          : part.state === "approval-requested"
                            ? "Awaiting answer"
                            : question.required
                              ? "Unanswered"
                              : "Skipped"}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {declined && (
            <p className="text-sm text-muted-foreground">{DECLINED_REASON}</p>
          )}
          {part.state === "output-available" &&
            part.output.code === "error" && (
              <p className="whitespace-pre-wrap text-sm text-destructive">
                {part.output.output}
              </p>
            )}
          {part.state === "approval-requested" && (
            <p className="text-sm text-muted-foreground">
              Answer the questionnaire in the conversation to continue.
            </p>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
};
