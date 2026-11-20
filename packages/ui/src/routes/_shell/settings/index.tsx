import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * One section owns the plain `/settings` address, so the address a reader
 * shares always names a section.
 */
export const Route = createFileRoute("/_shell/settings/")({
  beforeLoad: () => {
    // The router uses a thrown redirect as control flow, not as an error.
    // oxlint-disable-next-line typescript/only-throw-error
    throw redirect({ replace: true, to: "/settings/general" });
  },
});
