import { createFileRoute } from "@tanstack/react-router";
import { BotSettingsLayout } from "@workspace/ui/blocks/bots/bot-settings-layout";
import { COVERS_SESSION } from "@workspace/ui/lib/route-static-data";

export const Route = createFileRoute("/_shell/bots/$botId")({
  staticData: COVERS_SESSION,
  component: BotSettingsLayout,
});
