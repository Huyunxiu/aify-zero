import { createFileRoute } from "@tanstack/react-router";
import { readBotId, readProjectId } from "@workspace/ui/lib/session-search";

/**
 * The address of one session. The session itself is rendered by the shell, so
 * moving between addresses never unmounts it.
 */
export const Route = createFileRoute("/_shell/sessions/$sessionId")({
  validateSearch: (
    search: Record<string, unknown>
  ): { projectId?: string; botId?: string } => ({
    projectId: readProjectId(search),
    botId: readBotId(search),
  }),
});
