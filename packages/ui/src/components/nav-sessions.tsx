import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"
import { generateSessionId } from "@workspace/agent/utils/id-util"
import { useInfiniteQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible"
import { DropdownMenuItem } from "./dropdown-menu"
import {
  SessionRenameDialog,
  type RenamableSession,
} from "./session-rename-dialog"
import { SessionStatus } from "./session-status"
import { SidebarRowMenu } from "./sidebar-row-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { Button } from "./button";

const SESSION_PAGE_SIZE = 30;

export function NavSessions() {

  const navigate = useNavigate();
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<RenamableSession | null>(null);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["list_sessions"],
    queryFn: ({ pageParam }) =>
      client.session.list({
        cursor: pageParam,
        limit: SESSION_PAGE_SIZE,
        direction: "desc",
      }),
    initialPageParam: undefined as string | undefined,
    // The server does not return a next cursor, so derive it from the last
    // item. A short page means the list is exhausted.
    getNextPageParam: (lastPage) =>
      lastPage.sessions.length === SESSION_PAGE_SIZE
        ? lastPage.sessions.at(-1)?.id
        : undefined,
  });

  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel == null || !hasNextPage || isFetching) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) fetchNextPage();
    });
    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [hasNextPage, isFetching, fetchNextPage]);

  return (
    <>
      <Collapsible
        defaultOpen
        render={
          <SidebarGroup className="group/sessions group-data-[collapsible=icon]:hidden data-open:flex-1 data-open:min-h-0 py-0" />
        }
      >
        <div className="group/label relative flex items-center">
          <CollapsibleTrigger
            nativeButton={false}
            render={
              <SidebarGroupLabel className="min-w-0 flex-1 cursor-pointer items-center pr-8 [&>svg]:-rotate-90 [&>svg]:opacity-0 [&>svg]:transition-all data-panel-open:[&>svg]:rotate-0 group-hover/label:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100 font-normal" />
            }
          >
            <span>{t("sessions.title")}</span>
            <ChevronDownIcon className="ml-1" />
          </CollapsibleTrigger>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  aria-label={t("sessions.create")}
                  onClick={() =>
                    navigate({ to: `/sessions/${generateSessionId()}` })
                  }
                  className="pointer-events-none opacity-0 group-hover/label:pointer-events-auto group-hover/label:opacity-100 group-has-[:focus-visible]/label:pointer-events-auto group-has-[:focus-visible]/label:opacity-100 max-md:pointer-events-auto max-md:opacity-100"
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("sessions.create")}</TooltipContent>
          </Tooltip>
        </div>
        <CollapsibleContent className="min-h-0 data-open:flex data-open:flex-1 data-open:flex-col">
          <SidebarGroupContent className="scroll-fade scrollbar-none min-h-0 flex-1 overflow-y-auto">
            <SidebarMenu>
              {data?.pages.map((page) =>
                page.sessions.map((item) => (
                  <SidebarMenuItem key={item.id} className="group/item">
                    <SidebarMenuButton
                      onClick={() => navigate({ to: `/sessions/${item.id}` })}
                      className="cursor-pointer"
                      render={<div />}
                    >
                      <span className="inline-flex items-center gap-2">
                        <SessionStatus status={item.status} />
                        {item.title || t("sessions.untitled")}
                      </span>
                    </SidebarMenuButton>
                    <SidebarRowMenu label={t("sessions.actions")}>
                      <DropdownMenuItem
                        onClick={() => {
                          setRenaming({ id: item.id, title: item.title });
                        }}
                      >
                        <PencilIcon />
                        {t("sessions.rename")}
                      </DropdownMenuItem>
                    </SidebarRowMenu>
                  </SidebarMenuItem>
                )),
              )}
            </SidebarMenu>
            <div ref={sentinelRef}>
              {isFetchingNextPage ? t("sessions.loadingMore") : null}
            </div>
          </SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
      <SessionRenameDialog session={renaming} onOpenChange={setRenaming} />
    </>
  )
}
