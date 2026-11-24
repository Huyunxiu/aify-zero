import { createFileRoute } from "@tanstack/react-router";
import { BotRuntimeSection } from "@workspace/ui/elements/bots/bot-runtime-section";

export const Route = createFileRoute("/_shell/bots/$botId/settings/runtime")({
  component: BotRuntimeSection,
});
