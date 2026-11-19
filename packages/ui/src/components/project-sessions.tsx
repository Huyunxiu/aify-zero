import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSubButton,
} from "@workspace/ui/components/sidebar";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc";
import { RelativeTime } from "./relative-time";
import {
  SessionDeleteDialog,
  type DeletableSession,
} from "./session-delete-dialog";
import { SessionRowMenuItems } from "./session-row-actions";
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
  const [deleting, setDeleting] = useState<DeletableSession | null>(null);

  const { data, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["list_sessions", "project", projectId],
      queryFn: ({ pageParam }) =>
        client.session.listSessions({
          cursor: pageParam,
          limit: SESSION_PAGE_SIZE,
          direction: "desc",
          projectId,
        }),
      initialPageParam: undefined as string | undefined,
      // 游标由服务端给出：排序键是 (updatedAt, id)，这里拼不出来。
      getNextPageParam: (lastPage) => lastPage.nextCursor,
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
              <span className="min-w-0 flex-1 truncate">
                {session.title || t("sessions.untitled")}
              </span>
              {/* 行尾的槽位：平时显时间，悬停时让给右边出现的「…」。 */}
              <RelativeTime
                at={session.updatedAt}
                className="transition-opacity duration-150 group-hover/item:opacity-0 group-focus-within/item:opacity-0"
              />
            </SidebarMenuSubButton>
            <SidebarRowMenu
              label={t("sessions.actions")}
              className="top-1/2 -translate-y-1/2"
            >
              <SessionRowMenuItems
                session={session}
                onRename={() => {
                  setRenaming({ id: session.id, title: session.title });
                }}
                onDelete={() => {
                  setDeleting({ id: session.id, title: session.title });
                }}
              />
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
      <SessionDeleteDialog session={deleting} onOpenChange={setDeleting} />
    </>
  );
}
