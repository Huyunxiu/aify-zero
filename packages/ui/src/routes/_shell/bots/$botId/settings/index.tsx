import { createFileRoute } from "@tanstack/react-router";
import { redirectToFirstBotSection } from "@workspace/ui/elements/bots/bot-sections";

/** `/bots/$botId/settings` names no section, so it hands the reader to the first. */
export const Route = createFileRoute("/_shell/bots/$botId/settings/")({
  beforeLoad: ({ params }) => redirectToFirstBotSection(params),
});
