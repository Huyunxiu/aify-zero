import { createFileRoute } from "@tanstack/react-router";
import { AppSidebar } from "@workspace/ui/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
} from "@workspace/ui/components/sidebar";
import { Island, IslandGroup } from "@workspace/ui/elements/island";
import { SessionContainer } from "@workspace/ui/elements/session-container";

const Home = () => (
  <SidebarProvider>
    <AppSidebar />
    <SidebarInset className="bg-transparent">
      <IslandGroup orientation="horizontal">
        <Island defaultSize="50%">
          <SessionContainer />
        </Island>
        {/* <IslandHandle /> */}
        {/* <Island defaultSize="50%">
            <TitleBar></TitleBar>
            <div className="flex items-center justify-center p-6">
              <span className="font-semibold">Three</span>
            </div>
          </Island> */}
      </IslandGroup>
    </SidebarInset>
  </SidebarProvider>
);

export const Route = createFileRoute("/")({
  component: Home,
});
