import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"
import { useQuery } from "@tanstack/react-query"
import { ChevronDownIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible"

export function NavProjects() {

  const { t } = useTranslation();

  const { data } = useQuery({
    queryKey: ["list_projects"],
    queryFn: () => client.project.list(),
  });

  return (
    <Collapsible
      defaultOpen
      render={<SidebarGroup className="group/projects group-data-[collapsible=icon]:hidden" />}
    >
      <CollapsibleTrigger
        render={
          <SidebarGroupLabel className="cursor-pointer items-center [&>svg]:-rotate-90 [&>svg]:opacity-0 [&>svg]:transition-all data-panel-open:[&>svg]:rotate-0 group-hover/projects:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100" />
        }
      >
        <span>{t("projects.title")}</span>
        <ChevronDownIcon className="ml-1" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarGroupContent className="scroll-fade scrollbar-none max-h-[40vh] overflow-y-auto">
          <SidebarMenu>
            {data?.projects.map((item) => (
              <SidebarMenuItem key={item.id}>
                {/* 暂时只展示，不绑定点击行为。 */}
                <SidebarMenuButton className="cursor-default" render={<div />}>
                  <span>{item.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          {data?.projects.length === 0 ? (
            <p className="px-2 py-1 text-xs text-sidebar-foreground/50">
              {t("projects.empty")}
            </p>
          ) : null}
        </SidebarGroupContent>
      </CollapsibleContent>
    </Collapsible>
  )
}
