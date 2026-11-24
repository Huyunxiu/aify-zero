import { createFileRoute } from "@tanstack/react-router";
import { GeneralSettings } from "@workspace/ui/blocks/settings/general-settings";

export const Route = createFileRoute("/_shell/settings/general")({
  component: GeneralSettings,
});
