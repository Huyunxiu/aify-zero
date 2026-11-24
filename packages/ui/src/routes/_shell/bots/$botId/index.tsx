import { createFileRoute } from "@tanstack/react-router";
import { redirectToFirstBotSection } from "@workspace/ui/elements/bots/bot-sections";

/** The bare Bot address names no section, so it hands the reader to the first. */
export const Route = createFileRoute("/_shell/bots/$botId/")({
  beforeLoad: ({ params }) => redirectToFirstBotSection(params),
});
