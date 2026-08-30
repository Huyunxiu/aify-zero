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
import { useNavigate } from "@tanstack/react-router";

export function NavSessions() {

  const navigate = useNavigate();

  const listChatsQuery = useQuery({
    queryKey: ["list_chats"],
    queryFn: () => client.session.list({ limit: 20, direction: "desc" }),
  });

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Sessions</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {listChatsQuery.data?.sessions.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  onClick={() => navigate({ to: `/sessions/${item.id}` })}
                  className="cursor-pointer"
                  render={<div />}
                >
                  <span>{item.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
    </SidebarGroup>
  )
}
