import { NavSessions } from "@workspace/ui/components/nav-sessions";
import { NavProjects } from "@workspace/ui/components/nav-projects";
import { NavBottom } from "@workspace/ui/components/nav-bottom";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar";
import {
  PlusIcon,
} from "lucide-react";
import * as React from "react";
import { generateSessionId } from "@workspace/agent/utils/id-util";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "./button";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const navigate = useNavigate();
  return (
    <Sidebar variant="sidebar" {...props}>
      <SidebarHeader className="select-none py-0 mb-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <Button
              variant="outline"
              className="flex items-center justify-center w-full bg-foreground hover:bg-foreground/90 active:bg-foreground/90 text-accent hover:text-accent active:text-accent h-8"
              onClick={() => navigate({ to: `/sessions/${generateSessionId()}` })}
            >
              <PlusIcon />
              <span>New Session</span>
            </Button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="select-none">
         {/*<NavAgents />*/}
        <NavProjects />
        <NavSessions />
      </SidebarContent>
      <SidebarFooter className="select-none">
        <NavBottom />
      </SidebarFooter>
    </Sidebar>
  );
}
