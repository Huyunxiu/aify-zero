/**
 * The subagent view of the panel.
 *
 * It draws the record of the session that one `task` call made: read-only, no
 * prompt input, and no panel of its own. A subagent runs in its parent's
 * sandbox, so a second files, changes, or terminal panel would draw the same
 * workspace twice. It reads its own stream, so it keeps growing while the parent
 * session is still at work.
 */
import type { BotSummary } from "@workspace/agent-client";

import { useAgentSession } from "../../hooks/use-agent-session";
import { orpcReadOnlySessionTransport } from "../../lib/session-orpc-transport";
import { Transcript } from "../transcript/transcript";
import type { TranscriptEmpty } from "../transcript/transcript";

/** What a subagent that has written nothing yet says. It is not an invitation. */
const EMPTY_SUBAGENT: TranscriptEmpty = {
  description: "This subagent has not written anything yet.",
  title: "Nothing yet",
};

export type SubagentViewProps = {
  /** The session id of the subagent. */
  readonly sessionId: string;
  /** The Bot that owns it; a subagent row follows its parent. */
  readonly bot?: BotSummary | null;
};

/**
 * The record of one subagent.
 *
 * @param props.sessionId - Which session to read; the caller remounts it when
 * the id changes.
 */
export function SubagentView({ bot, sessionId }: SubagentViewProps) {
  const { error, hydrated, turns } = useAgentSession({
    id: sessionId,
    transport: orpcReadOnlySessionTransport,
  });

  if (!hydrated) {
    return null;
  }

  return (
    <Transcript bot={bot} empty={EMPTY_SUBAGENT} error={error} turns={turns} />
  );
}
