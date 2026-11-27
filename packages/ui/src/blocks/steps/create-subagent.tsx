import { BotIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  AgentStepButton,
  AgentStepDescription,
  AgentStepIcon,
  AgentStepRow,
  AgentStepTitle,
} from "../../blocks/chain-of-turn";
import { useSubagentAddress } from "../../hooks/use-subagent-address";
import { subagentSessionIdOf } from "../../lib/subagent-call";
import { ToolPanels } from "../tool-panels";
import { MarkdownBody } from "./markdown-body";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { summarizeTool } from "./summary";
import type { StepPartOf, StepViewProps } from "./types";

// Which subagent ran. A subagent that ended badly comes back as
// `code: "error"`, and the shared wrapper has already left the row to say that
// on its own.
export const createSubagentSummary = (
  part: StepPartOf<"tool-create-subagent">
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
 * shell: one row opens a dialog, the other points the panel at the child. It
 * reads and writes the address itself rather than taking a callback: the
 * selection is ambient, and a chain of props down to here would be a second
 * place that knows about it.
 */
export const CreateSubagentStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewProps<"tool-create-subagent">) => {
  const { select, selectedSubagentSessionId } = useSubagentAddress();

  const result = part.output?.output ?? "";
  const subagentSessionId = subagentSessionIdOf(part);
  // A call that failed before it made a subagent answers with the reason and
  // nothing else; one that failed outright has no answer at all, and an empty
  // panel under INPUT is worse than none.
  const showResult = result.length > 0;
  const summary = createSubagentSummary(part);
  const label = (
    <StepLabel action="Subagent" detail={part.input?.description} />
  );

  if (subagentSessionId) {
    return (
      <AgentStepButton
        onClick={() => {
          select(subagentSessionId);
        }}
        selected={selectedSubagentSessionId === subagentSessionId}
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
