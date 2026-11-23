import { createFileRoute } from "@tanstack/react-router";

/**
 * The session list. Its screen is the draft session in the shell, which has no
 * id until the first message; this route only gives the address a match.
 */
export const Route = createFileRoute("/_shell/sessions/")();
