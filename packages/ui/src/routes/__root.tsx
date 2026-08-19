import { createRootRoute, Outlet } from "@tanstack/react-router";
import { AppSidebar } from "@workspace/ui/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
} from "@workspace/ui/components/sidebar";

const RootComponent = () => (
  <>
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="bg-transparent">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  </>
);

export const Route = createRootRoute({
  component: RootComponent,
});
