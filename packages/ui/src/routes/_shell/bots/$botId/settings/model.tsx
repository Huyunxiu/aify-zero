import { createFileRoute } from "@tanstack/react-router";
import { BotModelSection } from "@workspace/ui/blocks/bots/bot-model-section";

export const Route = createFileRoute("/_shell/bots/$botId/settings/model")({
  component: BotModelSection,
});
