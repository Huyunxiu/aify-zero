import { useQuery } from "@tanstack/react-query";

import { client } from "../lib/orpc";
import type { QuestionnairePlacement } from "./questionnaire";
import { Session } from "./session";

export type SessionContainerProps = {
  sessionId?: string;
  /** 新建会话时预选的项目；已有会话行上的项目仍然优先。 */
  initialProjectId?: string;
  /** Whether the session is being read rather than written to. See {@link Session}. */
  readOnly?: boolean;
  /** Where a held questionnaire draws its form. See {@link Session}. */
  questionnairePlacement?: QuestionnairePlacement;
  /** Closes the pane showing this session, when it can be pointed elsewhere. */
  onClose?: () => void;
};

export function SessionContainer({
  sessionId,
  initialProjectId,
  readOnly,
  questionnairePlacement,
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
      // 本地状态属于某个会话：切到另一个会话时重新挂载，别让草稿和选中的
      // 项目串过去。会话 id 变了，内容就该从头开始。
      key={sessionId ?? "new"}
      sessionId={sessionId}
      initialTurns={initialTurns ?? []}
      initialProjectId={initialProjectId}
      readOnly={readOnly}
      questionnairePlacement={questionnairePlacement}
      onClose={onClose}
    />
  );
}
