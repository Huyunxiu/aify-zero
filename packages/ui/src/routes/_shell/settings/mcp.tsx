import { createFileRoute } from "@tanstack/react-router";
import { McpSettings } from "@workspace/ui/blocks/settings/mcp-settings";

export const Route = createFileRoute("/_shell/settings/mcp")({
  component: McpSettings,
});
