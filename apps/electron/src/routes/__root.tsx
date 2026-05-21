import { createRootRoute, Outlet } from "@tanstack/react-router";
// import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

const RootComponent = () => (
  <>
    <Outlet />
    {/*<TanStackRouterDevtools />*/}
  </>
);

export const Route = createRootRoute({
  component: RootComponent,
});
