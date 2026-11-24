import { createFileRoute } from "@tanstack/react-router";
import { BotSkillsSection } from "@workspace/ui/elements/bots/bot-skills-section";

export const Route = createFileRoute("/_shell/bots/$botId/settings/skills")({
  component: BotSkillsSection,
});
