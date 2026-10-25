import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSubButton,
} from "@workspace/ui/components/sidebar";
import { PencilIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc";
import { DropdownMenuItem } from "./dropdown-menu";
import {
  SessionRenameDialog,
  type RenamableSession,
} from "./session-rename-dialog";
import { SessionStatus } from "./session-status";
import { SidebarRowMenu } from "./sidebar-row-menu";

const SESSION_PAGE_SIZE = 30;

/**
 * 项目下挂的会话列表。和 `NavSessions` 同一个取数方式，只是多了 `projectId`
 * 过滤；查询 key 以 `["list_sessions", ...]` 开头，别处失效会话列表时这里会
 * 跟着刷新。
 */
export function ProjectSessions({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<RenamableSession | null>(null);

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
    <>
      <SidebarMenu>
        {sessions.map((session) => (
          <SidebarMenuItem key={session.id} className="group/item">
            <SidebarMenuSubButton
              className="w-full cursor-pointer pr-8"
              onClick={() => navigate({ to: `/sessions/${session.id}` })}
              render={<button type="button" />}
            >
              <SessionStatus status={session.status} />
              <span className="truncate">
                {session.title || t("sessions.untitled")}
              </span>
            </SidebarMenuSubButton>
            <SidebarRowMenu
              label={t("sessions.actions")}
              className="top-1/2 -translate-y-1/2"
            >
              <DropdownMenuItem
                onClick={() => {
                  setRenaming({ id: session.id, title: session.title });
                }}
              >
                <PencilIcon />
                {t("sessions.rename")}
              </DropdownMenuItem>
            </SidebarRowMenu>
          </SidebarMenuItem>
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
      </SidebarMenu>
      <SessionRenameDialog session={renaming} onOpenChange={setRenaming} />
    </>
  );
}
