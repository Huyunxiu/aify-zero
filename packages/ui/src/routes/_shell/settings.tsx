import { createFileRoute } from "@tanstack/react-router";
import { SettingsLayout } from "@workspace/ui/blocks/settings/settings-layout";
import { COVERS_SESSION } from "@workspace/ui/lib/route-static-data";

export const Route = createFileRoute("/_shell/settings")({
  staticData: COVERS_SESSION,
  component: SettingsLayout,
});
