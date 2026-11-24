import {
  createFileRoute,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { SessionHost } from "@workspace/ui/blocks/session-host";
import { isCoveringMatch } from "@workspace/ui/lib/route-static-data";

/**
 * The shell of the session area.
 *
 * The session stands outside the outlet, so a route below can cover it without
 * unmounting it. A route that covers says so with `staticData`, and the shell
 * asks that question instead of recognising addresses.
 */
const Shell = () => {
  const covered = useRouterState({
    select: (state) => state.matches.some(isCoveringMatch),
  });

  return (
    <>
      <div className="min-h-0 flex-1" inert={covered}>
        <SessionHost covered={covered} />
      </div>
      <Outlet />
    </>
  );
};

export const Route = createFileRoute("/_shell")({
  component: Shell,
});
