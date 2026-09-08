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
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc"

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
    <SidebarGroup className="group-data-[collapsible=icon]:hidden h-[calc(100vh-136px)]">
      <SidebarGroupLabel>Sessions</SidebarGroupLabel>
        <SidebarGroupContent className="scroll-fade scrollbar-none overflow-y-auto">
          <SidebarMenu>
            {data?.pages.map((page) =>
              page.sessions.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    onClick={() => navigate({ to: `/sessions/${item.id}` })}
                    className="cursor-pointer"
                    render={<div />}
                  >
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )),
            )}
          </SidebarMenu>
          <div ref={sentinelRef}>
            {isFetchingNextPage ? t("sessions.loadingMore") : null}
          </div>
        </SidebarGroupContent>
    </SidebarGroup>
  )
}
