import { createFileRoute, redirect } from "@tanstack/react-router";
import { DEFAULT_SETTINGS_SECTION } from "@workspace/ui/blocks/settings/sections";

/**
 * One section owns the plain `/settings` address, so the address a reader
 * shares always names a section.
 */
export const Route = createFileRoute("/_shell/settings/")({
  beforeLoad: () => {
    // The router uses a thrown redirect as control flow, not as an error.
    // oxlint-disable-next-line typescript/only-throw-error
    throw redirect({ replace: true, to: DEFAULT_SETTINGS_SECTION });
  },
});
