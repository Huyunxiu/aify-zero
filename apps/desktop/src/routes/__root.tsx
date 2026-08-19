import { createRootRoute, Outlet } from "@tanstack/react-router";

const RootComponent = () => (
  <>
    <Outlet />
    {/*<TanStackRouterDevtools />*/}
  </>
);

export const Route = createRootRoute({
  component: RootComponent,
});
