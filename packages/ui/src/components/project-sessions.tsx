import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@workspace/ui/components/sidebar";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc";
import { SessionStatus } from "./session-status";

const SESSION_PAGE_SIZE = 30;

/**
 * 项目下挂的会话列表。和 `NavSessions` 同一个取数方式，只是多了 `projectId`
 * 过滤；查询 key 以 `["list_sessions", ...]` 开头，别处失效会话列表时这里会
 * 跟着刷新。
 */
export function ProjectSessions({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const { data, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["list_sessions", "project", projectId],
      queryFn: ({ pageParam }) =>
        client.session.list({
          cursor: pageParam,
          limit: SESSION_PAGE_SIZE,
          direction: "desc",
          projectId,
        }),
      initialPageParam: undefined as string | undefined,
      // 服务端不返回下一个游标，用最后一项自己推；不足一页说明到底了。
      getNextPageParam: (lastPage) =>
        lastPage.sessions.length === SESSION_PAGE_SIZE
          ? lastPage.sessions.at(-1)?.id
          : undefined,
    });

  const sentinelRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel == null || !hasNextPage || isFetching) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) fetchNextPage();
    });
    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [hasNextPage, isFetching, fetchNextPage]);

  const sessions = data?.pages.flatMap((page) => page.sessions) ?? [];

  return (
    <SidebarMenuSub>
      {sessions.map((session) => (
        <SidebarMenuSubItem key={session.id}>
          <SidebarMenuSubButton
            className="w-full cursor-pointer"
            onClick={() => navigate({ to: `/sessions/${session.id}` })}
            render={<button type="button" />}
          >
            <SessionStatus status={session.status} />
            <span className="truncate">
              {session.title || t("sessions.untitled")}
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
      {!isFetching && sessions.length === 0 ? (
        <li className="px-2 py-1 text-xs text-sidebar-foreground/50">
          {t("projects.noSessions")}
        </li>
      ) : null}
      {isFetchingNextPage ? (
        <li className="px-2 py-1 text-xs text-sidebar-foreground/50">
          {t("sessions.loadingMore")}
        </li>
      ) : null}
      <li ref={sentinelRef} aria-hidden="true" className="h-px" />
    </SidebarMenuSub>
  );
}
