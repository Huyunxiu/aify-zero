import { useQuery } from "@tanstack/react-query";

import { client } from "../lib/orpc";
import { useAppStore } from "../stores";
import { Thread } from "./thread";

export function ThreadContainer() {
  const threadId = useAppStore((state) => state.threadId);
  const listThreadMessagesQuery = useQuery({
    queryKey: ["listThreadMessages", threadId],
    queryFn: async () =>
      await client.thread.listThreadMessages({ threadId: threadId ?? "" }),
    enabled: Boolean(threadId),
  });

  const initialMessages = listThreadMessagesQuery.data;

  return (
    <>
      {(initialMessages?.length ?? 0) > 0 && (
        <Thread threadId={threadId} initialMessages={initialMessages} />
      )}
      {!initialMessages?.length && (
        <Thread threadId={threadId} initialMessages={initialMessages} />
      )}
    </>
  );
}
