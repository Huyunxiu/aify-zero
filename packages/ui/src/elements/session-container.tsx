import { useQuery } from "@tanstack/react-query";

import { client } from "../lib/orpc";
import { Session } from "./session";

export type SessionContainerProps = {
  sessionId?: string;
};

export function SessionContainer({ sessionId }: SessionContainerProps) {
  const listSessionTurnsQuery = useQuery({
    queryKey: ["listSessionTurns", sessionId],
    queryFn: async () =>
      await client.session.listSessionTurns({ sessionId: sessionId ?? "" }),
    enabled: Boolean(sessionId),
  });

  const initialTurns = listSessionTurnsQuery.data;

  return (
    <>
      {(initialTurns?.length ?? 0) > 0 && (
        <Session sessionId={sessionId} initialTurns={initialTurns} />
      )}
      {!initialTurns?.length && (
        <Session sessionId={sessionId} initialTurns={initialTurns} />
      )}
    </>
  );
}
