import { getToolName } from "@workspace/agent-client";
import type { AgentToolPart, AgentToolSet } from "@workspace/agent-client";
import { WrenchIcon } from "lucide-react";

import { ToolPanels } from "../tool-panels";
import { StepFrame, StepLabel, StepShell } from "./shell";
import { pendingSummary } from "./summary";
import type { StepPart, StepViewPropsOf } from "./types";

/**
 * Which tool this row is about.
 *
 * A routed call is one call from the model's side and another from the tool's
 * side: the row names the tool that actually ran, because `call-tool` says
 * nothing. The real name is in the input; a call that has not got that far falls
 * back to its own name.
 */
export const getDisplayedToolName = (
  part: AgentToolPart<AgentToolSet>
): string => {
  if (part.type !== "tool-call-tool" || !("input" in part)) {
    return getToolName(part);
  }

  return part.input?.name || getToolName(part);
};

/**
 * Every call without a view of its own: the two catalog tools, and any tool the
 * host adds at run time.
 *
 * The routing tools name another tool in their input, and a dynamic tool is a
 * name this package has never heard of, so both read the name off the part.
 */
export const FallbackToolStep = ({
  part,
  status,
  duration,
  onRespond,
}: StepViewPropsOf<
  "dynamic-tool" | Extract<StepPart["type"], `tool-${string}`>
>) => {
  const toolName = getDisplayedToolName(part);
  const separator = toolName.indexOf("__");
  const serverName = separator > 0 ? toolName.slice(0, separator) : undefined;
  const shortName = separator > 0 ? toolName.slice(separator + 2) : toolName;

  return (
    <StepShell
      approvalPart={part}
      body={
        <StepFrame
          title={serverName ? `${serverName} · ${shortName}` : shortName}
        >
          <ToolPanels onRespond={onRespond} part={part} />
        </StepFrame>
      }
      duration={duration}
      icon={<WrenchIcon />}
      label={
        <StepLabel
          action={serverName ? `${serverName} · ${shortName}` : shortName}
        />
      }
      onRespond={onRespond}
      status={status}
      summary={pendingSummary(part)}
    />
  );
};
