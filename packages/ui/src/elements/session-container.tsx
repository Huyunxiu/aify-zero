import { useQuery } from "@tanstack/react-query";

import { client } from "../lib/orpc";
import type { QuestionnairePlacement } from "./questionnaire";
import { Session } from "./session";

export type SessionContainerProps = {
  sessionId?: string;
  /** Pre-selected Bot id when creating a session; existing session row always wins. */
  initialBotId?: string;
  /** 新建会话时预选的项目；已有会话行上的项目仍然优先。 */
  initialProjectId?: string;
  /** Whether the session is being read rather than written to. See {@link Session}. */
  readOnly?: boolean;
  /** Where a held questionnaire draws its form. See {@link Session}. */
  questionnairePlacement?: QuestionnairePlacement;
  /** Closes the pane showing this session, when it can be pointed elsewhere. */
  onClose?: () => void;
  /** Whether an opaque layer stands between the reader and this session. */
  covered: boolean;
};

export function SessionContainer({
  sessionId,
  initialBotId,
  initialProjectId,
  readOnly,
  questionnairePlacement,
  onClose,
  covered,
}: SessionContainerProps) {
  const listSessionTurnsQuery = useQuery({
    queryKey: ["listSessionTurns", sessionId],
    queryFn: async () =>
      await client.session.listSessionTurns({ sessionId: sessionId ?? "" }),
    enabled: Boolean(sessionId),
  });

  const initialTurns = listSessionTurnsQuery.data;

  // The transcript has to be in hand before the session mounts: the hook reads
  // its turns once, when the store is created, and a turn picked up mid-flight
  // continues from them. The home route has no session yet, so there is nothing
  // to wait for there.
  if (sessionId && listSessionTurnsQuery.isPending) {
    return null;
  }

  return (
    <Session
      key={sessionId ?? `new:${initialBotId ?? "default"}`}
      sessionId={sessionId}
      initialTurns={initialTurns ?? []}
      initialBotId={initialBotId}
      initialProjectId={initialProjectId}
      readOnly={readOnly}
      questionnairePlacement={questionnairePlacement}
      onClose={onClose}
      covered={covered}
    />
  );
}
