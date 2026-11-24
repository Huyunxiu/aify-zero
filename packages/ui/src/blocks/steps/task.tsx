import { BotIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  AgentStepButton,
  AgentStepDescription,
  AgentStepIcon,
  AgentStepRow,
  AgentStepTitle,
} from "../../components/ai-elements/chain-of-turn";
import { useSubagentPane } from "../../stores/subagent-pane";
import { ToolPanels } from "../tool-panels";
import { MarkdownBody } from "./markdown-body";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { summarizeTool } from "./summary";
import type { StepPartOf, StepViewProps } from "./types";

// Which subagent ran. A subagent that ended badly comes back as
// `code: "error"`, and the shared wrapper has already left the row to say that
// on its own.
export const taskSummary = (
  part: StepPartOf<"tool-task">
): ReactNode | undefined =>
  summarizeTool(part, () => part.input?.subagent_type);

/**
 * A subagent the model started.
 *
 * A call that started one is read in the pane beside this session, not in a
 * dialog over it: the transcript is the thing to see, and it is far too long to
 * sit in a dialog. A call that never got that far has only its own answer to
 * show, and the dialog is where that answer is readable.
 *
 * The two arrangements are why this view takes the whole row back from the
 * shell: one row opens a dialog, the other selects a pane.
 */
export const TaskStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-task">) => {
  // The subagent the pane beside this session is showing, and how to point it
  // at another. Read here rather than handed down: the pane is ambient state,
  // and this is the one view that asks for it.
  const selectedSessionId = useSubagentPane((state) => state.sessionId);
  const selectSubagent = useSubagentPane((state) => state.select);

  const result = part.output?.output ?? "";
  const subagentSessionId = part.output?.metadata?.sessionId;
  // A call that failed before it made a subagent answers with the reason and
  // nothing else; one that failed outright has no answer at all, and an empty
  // panel under INPUT is worse than none.
  const showResult = result.length > 0;
  const summary = taskSummary(part);
  const label = <StepLabel action="Task" detail={part.input?.description} />;

  if (subagentSessionId) {
    return (
      <AgentStepButton
        onClick={() => selectSubagent(subagentSessionId)}
        selected={selectedSessionId === subagentSessionId}
      >
        <AgentStepRow duration={duration} status={status}>
          <AgentStepIcon>
            <BotIcon />
          </AgentStepIcon>
          <AgentStepTitle>{label}</AgentStepTitle>
          {summary && <AgentStepDescription>{summary}</AgentStepDescription>}
        </AgentStepRow>
      </AgentStepButton>
    );
  }

  return (
    <StepShell
      approvalPart={part}
      body={
        <StepFrame title={label}>
          <ToolPanels
            hideOutput={!showResult}
            onRespond={onRespond}
            part={part}
            renderOutput={(text) => <MarkdownBody text={text} />}
          />
        </StepFrame>
      }
      duration={duration}
      icon={<BotIcon />}
      label={label}
      onRespond={onRespond}
      status={status}
      summary={summary}
    />
  );
};
