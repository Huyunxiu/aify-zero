import type {
  AgentAssistantTurn,
  AgentToolSet,
  BotSummary,
} from "@workspace/agent-client";
import { SplitIcon } from "lucide-react";

import {
  AgentActivity,
  AgentActivityContent,
  AgentActivityHeader,
} from "../blocks/chain-of-turn";
import type { ToolApprovalAnswer } from "../blocks/chain-of-turn";
import { CopyButton } from "../components/copy-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/tooltip";
import { useElapsedMs } from "../hooks/use-elapsed-ms";
import { useTouchPrimary } from "../hooks/use-touch-primary";
import { cn } from "../lib/utils";
import { splitAssistantMessageSteps } from "./assistant-entries";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "./message";
import { AssistantAvatar } from "./message-avatar";
import type { QuestionnairePlacement } from "./questionnaire";
import { SteeringStep } from "./steering-step";
import { StepView } from "./steps/registry";
import {
  formatDuration,
  getPartDurationMs,
  getPartStatus,
  summarizeTurn,
} from "./tool-step";

type AssistantMessageProps = {
  turn: AgentAssistantTurn<AgentToolSet>;
  /** The Bot that owns the session; its face stands beside every answer. */
  bot?: BotSummary | null;
  onFork?: (messageId: string) => void;
  /**
   * Answers a call the turn was held on. The turn is not re-run here: the caller
   * resumes it with the answer, and the resumed stream is what moves the step
   * on. Only the approval id is named — the step and the call it belongs to are
   * the caller's to look up in the transcript.
   */
  onRespondToolApproval?: (
    approvalId: string,
    approved: boolean,
    answer?: ToolApprovalAnswer
  ) => void;
  /**
   * Where a held questionnaire draws its form. `"inline"` — the default for a
   * transcript rendered on its own — keeps it beside the call that asked;
   * `"composer"` leaves it to the page, which draws it in the prompt input's
   * place and passes this back as something other than `"inline"`.
   */
  questionnairePlacement?: QuestionnairePlacement;
};

/**
 * The turn's elapsed time, kept in its own component so the once-a-second tick
 * re-renders this span and nothing else. Holding the clock in `AssistantMessage`
 * would re-render every step row on every tick.
 */
const TurnElapsed = ({ turn }: { turn: AgentAssistantTurn<AgentToolSet> }) => {
  const running = turn.status === "streaming";
  const elapsedMs = useElapsedMs({
    startedAt: turn.createdAt,
    endedAt: turn.completedAt,
    running,
  });

  // The tick lands wherever it lands within the second, so floor it: a timer
  // reading `3.4s` and then `4.4s` looks broken next to one that counts
  // seconds.
  return (
    <span>
      {formatDuration(
        running ? Math.floor(elapsedMs / 1000) * 1000 : elapsedMs
      )}
    </span>
  );
};

const TURN_HEADING = {
  streaming: "Working",
  done: "Finished",
  // A turn whose calls were held for approval: the model is not working, and
  // it is not finished either — the user is what it is waiting on.
  wait_review: "Awaiting review",
  aborted: "Stopped",
  error: "Failed",
} as const;

/**
 * One assistant turn: the chain of steps that led to its answer, and the answer.
 *
 * It composes and nothing more. Each step is drawn by the view its part names,
 * so this component never learns what a tool looks like — see `steps/registry`.
 * The status and the duration are read here because both are answers about the
 * record itself rather than about one tool.
 */
export const AssistantMessage = ({
  bot,
  turn,
  onFork,
  onRespondToolApproval,
  questionnairePlacement = "inline",
}: AssistantMessageProps) => {
  if (turn.type !== "assistant") {
    return null;
  }

  const isTouch = useTouchPrimary();
  const isRunning = turn.status === "streaming";
  const { answerPart, entries, parts } = splitAssistantMessageSteps(turn);

  return (
    <div className="group flex w-full items-start gap-3 pr-8">
      {/* A narrow pane does not draw the face: the title bar already names the
          Bot, and a 36px column would be taken from every line of the turn. */}
      <div className="hidden shrink-0 @min-[420px]:block">
        <AssistantAvatar bot={bot} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <AgentActivity defaultExpanded={new Set(["root"])}>
          <AgentActivityHeader
            path="root"
            loading={isRunning}
            summary={summarizeTurn(parts)}
            duration={<TurnElapsed turn={turn} />}
          >
            {TURN_HEADING[turn.status]}
          </AgentActivityHeader>
          <AgentActivityContent path="root">
            {entries.map((entry, index) => {
              if (entry.kind === "steering") {
                return <SteeringStep key={entry.step.id} step={entry.step} />;
              }

              const { part, step } = entry;
              const durationMs = getPartDurationMs(part, step);

              return (
                <StepView
                  key={index}
                  duration={
                    durationMs === undefined
                      ? undefined
                      : formatDuration(durationMs)
                  }
                  onRespond={onRespondToolApproval}
                  part={part}
                  questionnairePlacement={questionnairePlacement}
                  status={getPartStatus(part, turn.status)}
                />
              );
            })}
          </AgentActivityContent>
        </AgentActivity>
        {answerPart && (
          <Message from="assistant">
            <MessageContent>
              <MessageResponse
                controls={{
                  table: {
                    copy: false,
                    download: false,
                    fullscreen: false,
                  },
                }}
              >
                {answerPart.text}
              </MessageResponse>
            </MessageContent>
          </Message>
        )}
        {answerPart && (
          <MessageActions
            className={cn(
              !isTouch && [
                "opacity-0 pointer-events-none transition-opacity duration-150",
                "group-hover:opacity-100 group-hover:pointer-events-auto",
                "group-focus-within:opacity-100 group-focus-within:pointer-events-auto",
              ]
            )}
          >
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger render={<div />}>
                  <CopyButton
                    className="text-muted-foreground"
                    size="icon-sm"
                    variant="ghost"
                    label="Copy"
                    message={answerPart.text}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  <p>Copy to clipboard</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {onFork && (
              <MessageAction
                onClick={() => onFork(turn.id)}
                className="text-muted-foreground"
              >
                <SplitIcon />
              </MessageAction>
            )}
          </MessageActions>
        )}
      </div>
    </div>
  );
};
