import { createFileRoute } from "@tanstack/react-router";
import { Island, IslandGroup } from "@workspace/ui/elements/island";
import { SessionContainer } from "@workspace/ui/elements/session-container";

const SessionPage = () => {
  const { sessionId } = Route.useParams();
  return (
    <IslandGroup orientation="horizontal">
      <Island defaultSize="100%">
        <SessionContainer sessionId={sessionId} />
      </Island>
      {/* <IslandHandle />
    <Island defaultSize="35%">
      <TitleBar></TitleBar>
      <div className="flex items-center justify-center p-6"></div>
    </Island> */}
    </IslandGroup>
  );
};

export const Route = createFileRoute("/sessions/$sessionId")({
  component: SessionPage,
});
