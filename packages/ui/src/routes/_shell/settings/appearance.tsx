import { createFileRoute } from "@tanstack/react-router";
import { AppearanceSettings } from "@workspace/ui/blocks/settings/appearance-settings";

export const Route = createFileRoute("/_shell/settings/appearance")({
  component: AppearanceSettings,
});
