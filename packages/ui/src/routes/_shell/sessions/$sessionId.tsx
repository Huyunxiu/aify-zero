import { createFileRoute } from "@tanstack/react-router";

/**
 * The address of one session. The session itself is rendered by the shell, so
 * moving between addresses never unmounts it.
 */
export const Route = createFileRoute("/_shell/sessions/$sessionId")({
  // Optional: the global "new session" action has no project, and the session
  // then falls back to the default one.
  validateSearch: (
    search: Record<string, unknown>
  ): { projectId?: string } => ({
    projectId:
      typeof search.projectId === "string" && search.projectId !== ""
        ? search.projectId
        : undefined,
  }),
});
