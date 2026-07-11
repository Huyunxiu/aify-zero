import { createFileRoute } from "@tanstack/react-router";
import { AppSidebar } from "@workspace/ui/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
} from "@workspace/ui/components/sidebar";
import {
  Island,
  IslandGroup,
  IslandHandle,
} from "@workspace/ui/elements/island";
import { SessionContainer } from "@workspace/ui/elements/session-container";
import { TitleBar } from "@workspace/ui/elements/title-bar";

const Home = () => (
  <SidebarProvider>
    <AppSidebar />
    <SidebarInset className="bg-transparent">
      <IslandGroup orientation="horizontal">
        <Island defaultSize="65%">
          <SessionContainer />
        </Island>
        <IslandHandle />
        <Island defaultSize="35%">
          <TitleBar></TitleBar>
          <div className="flex items-center justify-center p-6"></div>
        </Island>
      </IslandGroup>
    </SidebarInset>
  </SidebarProvider>
);

export const Route = createFileRoute("/")({
  component: Home,
});
