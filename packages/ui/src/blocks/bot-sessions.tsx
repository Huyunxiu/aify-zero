import { useInfiniteQuery } from "@tanstack/react-query";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { HoverScrollText } from "@workspace/ui/components/hover-scroll-text";
import {
  SidebarMenuItem,
  SidebarMenuSubButton,
} from "@workspace/ui/components/sidebar";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc";
import { RelativeTime } from "./relative-time";
import { SessionDeleteDialog } from "./session-delete-dialog";
import type { DeletableSession } from "./session-delete-dialog";
import { SessionList } from "./session-list";
import { SessionRenameDialog } from "./session-rename-dialog";
import type { RenamableSession } from "./session-rename-dialog";
import { SessionRowMenuItems } from "./session-row-actions";
import { SessionStatus } from "./session-status";
import { SidebarRowMenu } from "./sidebar-row-menu";

const SESSION_PAGE_SIZE = 30;

/** Session list nested under a Bot in the sidebar, paginated with keyset cursor. */
export function BotSessions({ botId }: { botId: string }) {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<RenamableSession | null>(null);
  const [deleting, setDeleting] = useState<DeletableSession | null>(null);

  const { data, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["list_sessions", "bot", botId],
      queryFn: ({ pageParam }) =>
        client.session.listSessions({
          cursor: pageParam,
          limit: SESSION_PAGE_SIZE,
          direction: "desc",
          botId,
        }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });

  const sentinelRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel === null || !hasNextPage || isFetching) {
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        void fetchNextPage();
      }
    });
    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [hasNextPage, isFetching, fetchNextPage]);

  const sessions = data?.pages.flatMap((page) => page.sessions) ?? [];

  return (
    <>
      <SessionList>
        {sessions.map((session) => {
          const isCurrent = Boolean(
            matchRoute({
              to: "/sessions/$sessionId",
              params: { sessionId: session.id },
            })
          );

          return (
            <SidebarMenuItem key={session.id} className="group/item">
              <SidebarMenuSubButton
                isActive={isCurrent}
                className="group/scroll w-full cursor-pointer pr-8 transition-colors duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
                onClick={() =>
                  navigate({
                    to: "/sessions/$sessionId",
                    params: { sessionId: session.id },
                  })
                }
                render={<button type="button" />}
              >
                <SessionStatus status={session.status} />
                <HoverScrollText
                  className="flex-1"
                  value={session.title || t("sessions.untitled")}
                />
                <RelativeTime
                  at={session.updatedAt}
                  className="transition-opacity duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] group-hover/item:opacity-0 group-focus-within/item:opacity-0 motion-reduce:transition-none"
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
          );
        })}
        {!isFetching && sessions.length === 0 ? (
          <li className="px-2 py-1 text-xs text-sidebar-foreground/50">
            {t("bots.noSessions")}
          </li>
        ) : null}
        {isFetchingNextPage ? (
          <li className="px-2 py-1 text-xs text-sidebar-foreground/50">
            {t("sessions.loadingMore")}
          </li>
        ) : null}
        <li ref={sentinelRef} aria-hidden="true" className="h-px" />
      </SessionList>
      <SessionRenameDialog session={renaming} onOpenChange={setRenaming} />
      <SessionDeleteDialog session={deleting} onOpenChange={setDeleting} />
    </>
  );
}
