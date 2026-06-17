import { createFileRoute } from "@tanstack/react-router";
import { AppSidebar } from "@workspace/ui/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
} from "@workspace/ui/components/sidebar";
import { Island, IslandGroup } from "@workspace/ui/elements/island";
import { ThreadContainer } from "@workspace/ui/elements/thread-container";

const Home = () => (
  <SidebarProvider>
    <AppSidebar />
    <SidebarInset className="bg-transparent">
      <IslandGroup orientation="horizontal">
        <Island defaultSize="50%">
          <ThreadContainer />
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
