import { createFileRoute } from "@tanstack/react-router";
import { BotMcpSection } from "@workspace/ui/blocks/bots/bot-mcp-section";

export const Route = createFileRoute("/_shell/bots/$botId/settings/mcp")({
  component: BotMcpSection,
});
