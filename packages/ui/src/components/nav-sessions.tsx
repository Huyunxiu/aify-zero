import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"
import { useInfiniteQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible"
import { SessionStatus } from "./session-status"

const SESSION_PAGE_SIZE = 30;

export function NavSessions() {

  const navigate = useNavigate();
  const { t } = useTranslation();

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
    <Collapsible
      defaultOpen
      render={
        <SidebarGroup className="group/sessions group-data-[collapsible=icon]:hidden data-open:flex-1 data-open:min-h-0" />
      }
    >
      <CollapsibleTrigger
        render={
          <SidebarGroupLabel className="cursor-pointer items-center [&>svg]:-rotate-90 [&>svg]:opacity-0 [&>svg]:transition-all data-panel-open:[&>svg]:rotate-0 group-hover/sessions:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100" />
        }
      >
        <span>Sessions</span>
        <ChevronDownIcon className="ml-1" />
      </CollapsibleTrigger>
      <CollapsibleContent className="min-h-0 data-open:flex data-open:flex-1 data-open:flex-col">
        <SidebarGroupContent className="scroll-fade scrollbar-none min-h-0 flex-1 overflow-y-auto">
          <SidebarMenu>
            {data?.pages.map((page) =>
              page.sessions.map((item) => (
                <SidebarMenuItem key={item.id}>
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
  )
}
