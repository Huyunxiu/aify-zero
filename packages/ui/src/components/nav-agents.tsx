import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"
import { useQuery } from "@tanstack/react-query"
import { client } from "../lib/orpc"
import { Button } from "./button";
import { PlusIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { nanoid } from "nanoid";

export function NavAgents() {

  const navigate = useNavigate();

  const listAgentsQuery = useQuery({
    queryKey: ["list_agents"],
    queryFn: () => client.agent.list(),
  });

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel className="justify-between">
        <span>Agents</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => navigate({ to: `/agents/${nanoid()}` })}
        >
          <PlusIcon />
        </Button>
      </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {listAgentsQuery.data?.agents?.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  // onClick={() => setChatId(item.id)}
                  className="cursor-pointer"
                  render={<div />}
                >
                  <span>{item.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
    </SidebarGroup>
  )
}
