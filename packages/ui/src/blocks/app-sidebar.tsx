import { useNavigate } from "@tanstack/react-router";
import { DEFAULT_BOT_ID, generateSessionId } from "@workspace/agent-client";
import { NavBots } from "@workspace/ui/blocks/nav-bots";
import { NavBottom } from "@workspace/ui/blocks/nav-bottom";
import { NavProjects } from "@workspace/ui/blocks/nav-projects";
import { Button } from "@workspace/ui/components/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar";
import { PlusIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <Sidebar variant="sidebar" {...props}>
      <SidebarHeader className="select-none py-0 mb-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <Button
              variant="outline"
              className="flex h-8 w-full items-center justify-center bg-foreground text-accent hover:bg-foreground/90 hover:text-accent active:scale-[0.97] active:bg-foreground/90 active:text-accent transition-[transform,background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none motion-reduce:transform-none"
              onClick={() => {
                void navigate({
                  to: "/sessions/$sessionId",
                  params: { sessionId: generateSessionId() },
                  search: { botId: DEFAULT_BOT_ID },
                });
              }}
            >
              <PlusIcon />
              <span>{t("sessions.create")}</span>
            </Button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="select-none">
        <NavBots />
        <NavProjects />
      </SidebarContent>
      <SidebarFooter className="select-none">
        <NavBottom />
      </SidebarFooter>
    </Sidebar>
  );
}
