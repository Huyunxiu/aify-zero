import { useQuery } from "@tanstack/react-query";

import { client } from "../lib/orpc";
import { Session } from "./session";

export type SessionContainerProps = {
  sessionId?: string;
};

export function SessionContainer({ sessionId }: SessionContainerProps) {
  const listSessionMessagesQuery = useQuery({
    queryKey: ["listSessionMessages", sessionId],
    queryFn: async () =>
      await client.session.listSessionMessages({ sessionId: sessionId ?? "" }),
    enabled: Boolean(sessionId),
  });

  const initialMessages = listSessionMessagesQuery.data;

  return (
    <>
      {(initialMessages?.length ?? 0) > 0 && (
        <Session sessionId={sessionId} initialMessages={initialMessages} />
      )}
      {!initialMessages?.length && (
        <Session sessionId={sessionId} initialMessages={initialMessages} />
      )}
    </>
  );
}
