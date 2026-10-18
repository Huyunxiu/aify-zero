import { createFileRoute } from "@tanstack/react-router";
import {
  Island,
  IslandGroup,
  IslandHandle,
} from "@workspace/ui/elements/island";
import { SessionContainer } from "@workspace/ui/elements/session-container";
import { useSubagentPane } from "@workspace/ui/stores/subagent-pane";
import * as React from "react";

const SessionPage = () => {
  const { sessionId } = Route.useParams();

  // The pane beside the session reads whatever `task` row was last clicked, and
  // holds a session of its own while nothing has been. The selection is a store
  // rather than state here because the click that makes it happens inside the
  // session on the left, which this component does not render into.
  const subagentSessionId = useSubagentPane((state) => state.sessionId);
  const clearSubagent = useSubagentPane((state) => state.clear);

  // A selection belongs to the session it was made in. Moving to another one
  // leaves the pane holding a child of the session that is no longer on screen,
  // and nothing there could have pointed at it.
  React.useEffect(() => {
    clearSubagent();
  }, [sessionId, clearSubagent]);

  return (
    <IslandGroup orientation="horizontal">
      <Island defaultSize={subagentSessionId ? "50%" : "100%"}>
        <SessionContainer sessionId={sessionId} />
      </Island>
      {subagentSessionId && (
        <>
          <IslandHandle />
          <Island defaultSize="50%">
            <SessionContainer
              sessionId={subagentSessionId ?? undefined}
              readOnly={Boolean(subagentSessionId)}
              onClose={subagentSessionId ? clearSubagent : undefined}
            />
          </Island>
        </>
      )}
    </IslandGroup>
  );
};

export const Route = createFileRoute("/sessions/$sessionId")({
  component: SessionPage,
});
