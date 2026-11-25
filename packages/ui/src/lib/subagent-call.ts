import type {
  AgentAssistantPart,
  AgentToolSet,
  AgentTurn,
} from "@workspace/agent-client";

/** The `task` part of a step: the one call that starts a subagent. */
type TaskPart = Extract<
  AgentAssistantPart<AgentToolSet>,
  { type: "tool-task" }
>;

/**
 * Reads the session id that a `task` call reports for the subagent it started.
 *
 * The call reports the id before it finishes, so a reader can follow the row
 * while the subagent still works. A call that never got that far has no id.
 *
 * @param part - The `task` part of a step.
 * @returns The session id of the subagent; undefined when the call made none.
 */
export const subagentSessionIdOf = (part: TaskPart): string | undefined =>
  part.output?.metadata?.sessionId;

/**
 * Finds the description that the `task` call which started this subagent wrote.
 *
 * The row of that session carries the same text as its title, so the record
 * already names it. A name for a tab costs no request.
 *
 * A missing result has two causes: the address names a subagent that this
 * record never started, or the call is no longer in it. Both mean "this session
 * has no such subagent", and that is what the caller needs to know.
 *
 * @param turns - The turns of the parent session, in order.
 * @param subagentSessionId - The session id of the subagent.
 * @returns The description; undefined when no call in this record started it.
 */
export function findSubagentTitle(
  turns: readonly AgentTurn<AgentToolSet>[],
  subagentSessionId: string
): string | undefined {
  for (const turn of turns) {
    if (turn.type !== "assistant") {
      continue;
    }

    for (const step of turn.content) {
      for (const part of step.content) {
        if (
          part.type === "tool-task" &&
          subagentSessionIdOf(part) === subagentSessionId
        ) {
          return part.input?.description;
        }
      }
    }
  }

  return undefined;
}
