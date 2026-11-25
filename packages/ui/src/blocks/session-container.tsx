import { useSessionTurns } from "../hooks/use-session-turns";
import type { QuestionnairePlacement } from "./questionnaire";
import { Session } from "./session";

export type SessionContainerProps = {
  sessionId?: string;
  /** Pre-selected Bot id when creating a session; existing session row always wins. */
  initialBotId?: string;
  /** 新建会话时预选的项目；已有会话行上的项目仍然优先。 */
  initialProjectId?: string;
  /** Where a held questionnaire draws its form. See {@link Session}. */
  questionnairePlacement?: QuestionnairePlacement;
  /** Whether an opaque layer stands between the reader and this session. */
  covered: boolean;
};

export function SessionContainer({
  sessionId,
  initialBotId,
  initialProjectId,
  questionnairePlacement,
  covered,
}: SessionContainerProps) {
  const turnsQuery = useSessionTurns(sessionId);
  const initialTurns = turnsQuery.data;

  // The transcript has to be in hand before the session mounts: the hook reads
  // its turns once, when the store is created, and a turn picked up mid-flight
  // continues from them. The home route has no session yet, so there is nothing
  // to wait for there.
  if (sessionId && turnsQuery.isPending) {
    return null;
  }

  return (
    <Session
      key={sessionId ?? `new:${initialBotId ?? "default"}`}
      sessionId={sessionId}
      initialTurns={initialTurns ?? []}
      initialBotId={initialBotId}
      initialProjectId={initialProjectId}
      questionnairePlacement={questionnairePlacement}
      covered={covered}
    />
  );
}
