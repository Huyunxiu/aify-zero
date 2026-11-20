import { createFileRoute } from "@tanstack/react-router";
import { ProviderSettings } from "@workspace/ui/elements/settings/provider-settings";

export const Route = createFileRoute("/_shell/settings/provider")({
  component: ProviderSettings,
});
