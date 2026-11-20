import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The root address has no screen of its own: a visit lands on the session list.
 *
 * `replace` keeps the empty address out of history. A reader who comes back
 * with the back button should leave the app, not land on a second redirect.
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    // The router uses a thrown redirect as control flow, not as an error.
    // oxlint-disable-next-line typescript/only-throw-error
    throw redirect({ replace: true, to: "/sessions" });
  },
});
