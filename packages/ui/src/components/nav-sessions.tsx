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
import { useAppStore } from "../stores"

export function NavSessions() {

  const setChatId = useAppStore((state) => state.setSessionId);

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
                  onClick={() => setChatId(item.id)}
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
