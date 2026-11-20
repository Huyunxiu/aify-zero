import { useMatchRoute, useParams, useSearch } from "@tanstack/react-router";
import {
  Island,
  IslandGroup,
  IslandHandle,
} from "@workspace/ui/elements/island";
import { SessionContainer } from "@workspace/ui/elements/session-container";
import { useSubagentPane } from "@workspace/ui/stores/subagent-pane";
import * as React from "react";

export type SessionHostProps = {
  /** An opaque layer stands between the reader and this session. */
  covered: boolean;
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

  // A covering route has no session in its address. The host remembers the last
  // one it showed, so coming back lands on the same session.
  const lastSessionId = React.useRef(sessionId);
  React.useEffect(() => {
    if (sessionId !== undefined) {
      lastSessionId.current = sessionId;
    }
  }, [sessionId]);

  // "new" is the session list's draft, which has no id until the first message.
  const shownSessionId: string | "new" | undefined =
    sessionId ??
    (atSessionList
      ? "new"
      : covered
        ? (lastSessionId.current ?? undefined)
        : undefined);

  const subagentSessionId = useSubagentPane((state) => state.sessionId);
  const clearSubagent = useSubagentPane((state) => state.clear);

  // A selection belongs to the session it was made in. Moving to another one
  // leaves the pane holding a child of a session that is no longer on screen.
  // A covering route is not a move: the session underneath did not change.
  React.useEffect(() => {
    clearSubagent();
  }, [shownSessionId, clearSubagent]);

  if (shownSessionId === undefined) {
    return null;
  }

  const projectId =
    typeof search.projectId === "string" ? search.projectId : undefined;

  return (
    <IslandGroup orientation="horizontal">
      <Island defaultSize={subagentSessionId ? "50%" : "100%"}>
        <SessionContainer
          covered={covered}
          initialProjectId={projectId}
          sessionId={shownSessionId === "new" ? undefined : shownSessionId}
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
