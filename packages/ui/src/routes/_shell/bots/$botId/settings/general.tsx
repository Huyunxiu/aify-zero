import { createFileRoute } from "@tanstack/react-router";
import { BotGeneralSection } from "@workspace/ui/blocks/bots/bot-general-section";

export const Route = createFileRoute("/_shell/bots/$botId/settings/general")({
  component: BotGeneralSection,
});
