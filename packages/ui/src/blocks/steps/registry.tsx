import { isAgentToolPart } from "@workspace/agent-client";
import type { ComponentType } from "react";

import { CompactionStep } from "./compaction";
import { DeleteFileStep } from "./delete-file";
import { EditFileStep } from "./edit-file";
import { FallbackToolStep } from "./fallback-tool";
import { GlobStep } from "./glob";
import { GrepStep } from "./grep";
import { JobsStep } from "./jobs";
import { LoadSkillStep } from "./load-skill";
import { NoteStep } from "./note";
import { QuestionnaireStep } from "./questionnaire";
import { ReadFileStep } from "./read-file";
import { ReasoningStep } from "./reasoning";
import { RetryStep } from "./retry";
import { ShellToolStep } from "./shell-tool";
import { TaskStep } from "./task";
import type { StepPart, StepViewProps } from "./types";
import { WebFetchStep } from "./web-fetch";
import { WriteFileStep } from "./write-file";

/**
 * One view per part, and no fewer.
 *
 * A part the protocol gains has to arrive with a view, or this record no longer
 * describes the union and fails to compile. That is the point: a tool or a part
 * kind that silently renders nothing is a bug the type system can catch.
 */
export type StepViews = {
  [TYPE in StepPart["type"]]: ComponentType<StepViewProps<TYPE>>;
};

/** The parts that draw nothing: the protocol keeps them, this transcript does not show them. */
const NothingStep = () => null;

export const stepViews: StepViews = {
  compaction: CompactionStep,
  // A provider's own content, and a title the transcript never shows beside its
  // steps. Their silence is a decision, so it is written down rather than left
  // to a default branch.
  custom: NothingStep,
  "session.title": NothingStep,
  reasoning: ReasoningStep,
  retry: RetryStep,
  text: NoteStep,

  "dynamic-tool": FallbackToolStep,
  "tool-bash": ShellToolStep,
  "tool-call-tool": FallbackToolStep,
  "tool-delete-file": DeleteFileStep,
  "tool-edit-file": EditFileStep,
  "tool-glob": GlobStep,
  "tool-grep": GrepStep,
  "tool-job-kill": JobsStep,
  "tool-job-list": JobsStep,
  "tool-job-output": JobsStep,
  "tool-load-skill": LoadSkillStep,
  "tool-powershell": ShellToolStep,
  "tool-questionnaire": QuestionnaireStep,
  "tool-read-file": ReadFileStep,
  "tool-search-tools": FallbackToolStep,
  "tool-task": TaskStep,
  "tool-web-fetch": WebFetchStep,
  "tool-write-file": WriteFileStep,
};

/**
 * The view for one part.
 *
 * The table is exhaustive over the parts the protocol declares, and a part type
 * added there fails to compile. A transcript can still hold a call the union
 * cannot name: a host tool arrives as `tool-<server>__<tool>`, and a turn written
 * by another version carries whatever tools that version had. Those are still
 * calls, so they read as one. A part the table cannot name that is not a call
 * draws nothing — which is what the chain did before this table existed.
 */
export const viewFor = (part: StepPart): ComponentType<StepViewProps> => {
  const view = (
    stepViews as Record<string, ComponentType<StepViewProps> | undefined>
  )[part.type];

  if (view !== undefined) {
    return view;
  }

  return isAgentToolPart(part)
    ? (FallbackToolStep as ComponentType<StepViewProps>)
    : NothingStep;
};

/**
 * Draws one step of the chain.
 *
 * The cast in `viewFor` closes the one gap TypeScript cannot: a key looked up at
 * run time. The table's own type is what keeps that cast honest, because every
 * entry accepts exactly the part its key names.
 */
export const StepView = ({ part, ...props }: StepViewProps) => {
  const View = viewFor(part);

  return <View part={part} {...props} />;
};
