import { createFileRoute } from "@tanstack/react-router";
import { validateSessionSearch } from "@workspace/ui/lib/session-search";

/**
 * The session list. Its screen is the draft session in the shell, which has no
 * id until the reader starts one from the sidebar: this route only gives the
 * address a match.
 *
 * It declares the same search as a saved session, and for one reason: the Bot
 * and the project are read from the address here too. It is not a second way to
 * show a subagent — a session with no id in its address has no side panel, so
 * this address selects nothing and drops the key.
 */
export const Route = createFileRoute("/_shell/sessions/")({
  validateSearch: validateSessionSearch,
});
