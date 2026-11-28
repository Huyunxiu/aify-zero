import type {
  AgentStaticToolPart,
  AgentToolPart,
  AgentToolSet,
} from "@workspace/agent-client";
import type { ReactNode } from "react";

/**
 * What a call's row reads before a result exists, and how a view reads the
 * result once it does.
 *
 * These are shared because none of them is about one tool: one is the wording of
 * a call that is still waiting on somebody, the other is what "finished well"
 * means for a call at all. A view that decided either on its own would be a
 * second authority for the same sentence — and twelve views needed both.
 */

/**
 * What a call says while it has no result yet: the user is being asked, or the
 * step has not run. A call a policy approves on its own is not waiting on the
 * user, so it says nothing.
 */
export const pendingSummary = (
  part: AgentToolPart<AgentToolSet>
): string | undefined => {
  if (part.state === "approval-requested") {
    if (part.approval.isAutomatic) {
      return undefined;
    }
    return part.type === "tool-questionnaire"
      ? "awaiting answers"
      : "awaiting approval";
  }

  // A `create-subagent` call is the one row worth reading before it has
  // finished: its label holds the description the model wrote, which does not
  // say which subagent is at work.
  if (
    part.type === "tool-create-subagent" &&
    part.state === "input-available"
  ) {
    return part.input?.subagent_type;
  }

  return undefined;
};

/** The answered half of a tool part's state union. */
type Answered<P extends AgentStaticToolPart<AgentToolSet>> = Extract<
  P,
  { state: "output-available" }
>;

/** What an answered part carries: its tool's own result and metadata. */
type OutputOf<ANSWERED> = ANSWERED extends { output: infer OUTPUT }
  ? OUTPUT
  : never;

/**
 * The result of a call that finished well, or undefined for every other shape.
 *
 * A call that reported `code: "error"` did not succeed — the row's own `Failed`
 * label carries that — and a call still running has nothing to read. This is not
 * `getPartStatus`: a call that reported its name before finishing is
 * `running` on the row and still has a result worth reading, so the two
 * questions stay apart on purpose.
 *
 * The cast at the top names the union member the guard is about to prove. It is
 * the only way to keep the tool's own `output` type through the check: widening
 * the part to the tool set would merge every tool's metadata into one shape and
 * leave the view unable to read `matchCount` or `linesAdded`.
 */
export const finishedOutput = <P extends AgentStaticToolPart<AgentToolSet>>(
  part: P
): OutputOf<Answered<P>> | undefined => {
  const answered = part as Answered<P>;

  if (answered.state !== "output-available" || answered.output.code !== "ok") {
    return undefined;
  }

  return answered.output as OutputOf<Answered<P>>;
};

/**
 * A tool's summary in the one order every tool reads it: what the call says
 * while it waits, and what its own result says once there is one.
 *
 * `read` is where a view states the one thing that is its own — how to word its
 * metadata. A view that never reaches a result gets nothing to read.
 */
export const summarizeTool = <P extends AgentStaticToolPart<AgentToolSet>>(
  part: P,
  read: (output: OutputOf<Answered<P>>) => ReactNode | undefined
): ReactNode | undefined => {
  const pending = pendingSummary(part);
  if (pending !== undefined) {
    return pending;
  }

  const output = finishedOutput(part);

  return output === undefined ? undefined : read(output);
};
