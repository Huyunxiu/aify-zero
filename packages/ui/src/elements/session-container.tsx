import { useQuery } from "@tanstack/react-query";

import { client } from "../lib/orpc";
import { Session } from "./session";

export type SessionContainerProps = {
  sessionId?: string;
  /** Whether the session is being read rather than written to. See {@link Session}. */
  readOnly?: boolean;
  /** Closes the pane showing this session, when it can be pointed elsewhere. */
  onClose?: () => void;
};

export function SessionContainer({
  sessionId,
  readOnly,
  onClose,
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
      sessionId={sessionId}
      initialTurns={initialTurns ?? []}
      readOnly={readOnly}
      onClose={onClose}
    />
  );
}
