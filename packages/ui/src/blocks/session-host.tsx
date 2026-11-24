import { useMatchRoute, useParams, useSearch } from "@tanstack/react-router";
import { Island, IslandGroup, IslandHandle } from "@workspace/ui/blocks/island";
import { SessionContainer } from "@workspace/ui/blocks/session-container";
import { readBotId, readProjectId } from "@workspace/ui/lib/session-search";
import { useSubagentPane } from "@workspace/ui/stores/subagent-pane";
import * as React from "react";

export type SessionHostProps = {
  /** An opaque layer stands between the reader and this session. */
  covered: boolean;
};

/** The session the host shows: a saved one, or the session list's draft. */
type ShownSession =
  | {
      readonly kind: "draft";
      readonly botId?: string;
      readonly projectId?: string;
    }
  | {
      readonly id: string;
      readonly kind: "id";
      readonly botId?: string;
      readonly projectId?: string;
    };

/**
 * The session on screen, owned by the shell rather than by a route.
 *
 * A route change swaps what covers the session; it never unmounts it. That is
 * what keeps the live stream, the draft and the scroll position: they belong to
 * a mounted `Session`, not to the address.
 *
 * The host reads the address itself because the routes under it render nothing.
 */
export function SessionHost({ covered }: SessionHostProps) {
  // Without a route id the router hands back the merged values as `any`; the
  // annotations turn them into something a reader can narrow.
  const params: Record<string, unknown> = useParams({ strict: false });
  const search: Record<string, unknown> = useSearch({ strict: false });
  const atSessionList = useMatchRoute()({ to: "/sessions" });

  const sessionId =
    typeof params.sessionId === "string" ? params.sessionId : undefined;
  const searchProjectId = readProjectId(search);
  const searchBotId = readBotId(search);

  const liveSession = React.useMemo<ShownSession | undefined>(() => {
    if (covered) {
      return;
    }
    if (sessionId !== undefined) {
      return {
        id: sessionId,
        kind: "id",
        botId: searchBotId,
        projectId: searchProjectId,
      };
    }
    if (atSessionList) {
      return {
        kind: "draft",
        botId: searchBotId,
        projectId: searchProjectId,
      };
    }
  }, [covered, sessionId, searchBotId, searchProjectId, atSessionList]);

  // A covering route has no session in its address. The host remembers what it
  // showed last (including draft botId/projectId), so coming back or reconfiguring
  // the active Bot underneath lands on the exact same session without resetting it.
  const lastShown = React.useRef<ShownSession | undefined>(liveSession);
  React.useEffect(() => {
    if (!covered && liveSession !== undefined) {
      lastShown.current = liveSession;
    }
  }, [covered, liveSession]);

  const shownSession: ShownSession | undefined = covered
    ? lastShown.current
    : liveSession;

  const activeSessionId =
    shownSession?.kind === "id" ? shownSession.id : undefined;
  const shownKey =
    shownSession === undefined
      ? undefined
      : shownSession.kind === "id"
        ? `id:${shownSession.id}`
        : "draft";

  const subagentSessionId = useSubagentPane((state) => state.sessionId);
  const clearSubagent = useSubagentPane((state) => state.clear);

  // A selection belongs to the session it was made in. Moving to another one
  // leaves the pane holding a child of a session that is no longer on screen.
  // A covering route is not a move: the session underneath did not change.
  React.useEffect(() => {
    clearSubagent();
  }, [shownKey, clearSubagent]);

  // The session list shows a draft session, which has no id until the first
  // message. A covering route shows nothing only when there was nothing before.
  if (shownSession === undefined) {
    return null;
  }

  return (
    <IslandGroup orientation="horizontal">
      <Island defaultSize={subagentSessionId ? "50%" : "100%"}>
        <SessionContainer
          covered={covered}
          initialBotId={shownSession.botId}
          initialProjectId={shownSession.projectId}
          sessionId={activeSessionId}
        />
      </Island>
      {subagentSessionId && (
        <>
          <IslandHandle />
          <Island defaultSize="50%">
            <SessionContainer
              covered={covered}
              onClose={clearSubagent}
              readOnly
              sessionId={subagentSessionId}
            />
          </Island>
        </>
      )}
    </IslandGroup>
  );
}
