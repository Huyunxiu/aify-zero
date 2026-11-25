/**
 * The subagent view of the panel.
 *
 * It draws the record of the session that one `task` call made: read-only, no
 * prompt input, and no panel of its own. A subagent runs in its parent's
 * sandbox, so a second files, changes, or terminal panel would draw the same
 * workspace twice. It reads its own stream, so it keeps growing while the parent
 * session is still at work.
 */
import type {
  AgentToolSet,
  AgentTurn,
  BotSummary,
} from "@workspace/agent-client";

import { useAgentSession } from "../../hooks/use-agent-session";
import { useSessionTurns } from "../../hooks/use-session-turns";
import { openSessionEvents } from "../../lib/session-events";
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
  const turnsQuery = useSessionTurns(sessionId);

  // The record must be in hand before the transcript mounts: the store reads its
  // seed turns once, and the stream then maintains them.
  if (turnsQuery.isPending) {
    return null;
  }

  return (
    <SubagentTranscript
      bot={bot}
      initialTurns={turnsQuery.data ?? []}
      sessionId={sessionId}
    />
  );
}

type SubagentTranscriptProps = {
  readonly sessionId: string;
  readonly initialTurns: AgentTurn<AgentToolSet>[];
  readonly bot?: BotSummary | null;
};

/**
 * Reads the subagent whose turns are already in hand.
 *
 * It is read-only: `allowSend` is off and no inbox callback is passed, so it
 * never lists the pending-message queue — that queue belongs to the `task` call,
 * not to the person reading it.
 */
function SubagentTranscript({
  bot,
  initialTurns,
  sessionId,
}: SubagentTranscriptProps) {
  const { error, turns } = useAgentSession({
    id: sessionId,
    apiEvents: async ({ abortSignal, sessionId: id }) =>
      await openSessionEvents(id, abortSignal),
    allowSend: false,
    turns: initialTurns,
  });

  return (
    <Transcript bot={bot} empty={EMPTY_SUBAGENT} error={error} turns={turns} />
  );
}
