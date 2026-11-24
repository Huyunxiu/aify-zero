import type {
  AgentAssistantPart,
  AgentCompactionPart,
  AgentToolSet,
} from "@workspace/agent-client";

import type {
  AgentStepStatus,
  ToolApprovalAnswer,
} from "../../blocks/chain-of-turn";
import type { QuestionnairePlacement } from "../questionnaire";

/**
 * The parts a step view draws.
 *
 * An assistant step holds everything on the model's side; a compaction marker
 * is the one part an assistant turn carries in the place a step of its own
 * would stand. Nothing a user step holds reaches the chain: `assistant-entries`
 * turns a steering step into an entry of its own.
 */
export type StepPart = AgentAssistantPart<AgentToolSet> | AgentCompactionPart;

/** Answers a call the turn was held on. The caller resumes the turn. */
export type ToolRespond = (
  approvalId: string,
  approved: boolean,
  answer?: ToolApprovalAnswer
) => void;

/** The part a view for `TYPE` draws. */
export type StepPartOf<TYPE extends StepPart["type"]> = Extract<
  StepPart,
  { type: TYPE }
>;

/**
 * What every view receives.
 *
 * `status` and `duration` are read once, by the message, because both are
 * answers about the record itself — every view would otherwise ask the same
 * question and get the same answer.
 */
export type StepViewProps<TYPE extends StepPart["type"] = StepPart["type"]> = {
  part: StepPartOf<TYPE>;
  status: AgentStepStatus;
  /** How long the step took, already formatted; absent when it is not known. */
  duration?: string;
  onRespond?: ToolRespond;
  /**
   * Where a held questionnaire draws its form. Only the questionnaire view
   * reads it, and every other view ignores it — the alternative is a second
   * props type for the one view that differs.
   */
  questionnairePlacement?: QuestionnairePlacement;
};

/**
 * The props of a view that serves several names, one union of their props.
 *
 * The union matters: a view declared with `StepViewProps<A | B>` describes one
 * object whose `part` is the union, and the registry cannot place it in a slot
 * that names a single part. Written this way, a slot for `A` receives exactly
 * the props it declares.
 */
export type StepViewPropsOf<NAMES extends StepPart["type"]> =
  NAMES extends StepPart["type"] ? StepViewProps<NAMES> : never;
