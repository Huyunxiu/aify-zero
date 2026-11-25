import { useQuery } from "@tanstack/react-query";

import { client } from "../lib/orpc";

/**
 * Reads the turns of a session before its transcript mounts.
 *
 * A transcript store reads its seed turns once, when it is created, and a turn
 * that is already running then continues from them. So the record must be in
 * hand before the transcript mounts, and both places that mount one wait on this
 * query the same way.
 *
 * @param sessionId - The session to read; nothing is requested without one.
 */
export function useSessionTurns(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["listSessionTurns", sessionId],
    queryFn: async () =>
      await client.session.listSessionTurns({ sessionId: sessionId ?? "" }),
    enabled: Boolean(sessionId),
  });
}
