import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { getErrorMessage } from "@workspace/shared/errors";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";

/** 删除只需要这两个字段，列表里拿到的会话够用。 */
export type DeletableSession = {
  id: string;
  title: string | null;
};

type SessionDeleteDialogProps = {
  /** `null` 表示关闭；传会话就是打开并删除它。 */
  session: DeletableSession | null;
  onOpenChange: (session: DeletableSession | null) => void;
};

/**
 * 会话行菜单里的「删除」：一次确认，然后把这个会话从所有列表里拿走。
 *
 * 删掉的是「将来还会发生的事」——定时器、待办项、发件项；转录留在库里，等回收站
 * 那期（ADR 0020）。所以文案不说「永久删除」。
 */
export function SessionDeleteDialog({
  session,
  onOpenChange,
}: SessionDeleteDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();

  const removal = useMutation({
    mutationFn: (sessionId: string) =>
      client.session.deleteSession({ sessionId }),
    onSuccess: async (_result, sessionId) => {
      // 项目下的会话列表用同一个前缀，一起失效。
      await queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
      // 删掉的会话不该在缓存里留一份：切回来会挂载到一个不存在的东西上。
      queryClient.removeQueries({ queryKey: ["getSession", sessionId] });
      queryClient.removeQueries({ queryKey: ["listSessionTurns", sessionId] });
      queryClient.removeQueries({
        queryKey: ["listSessionResources", sessionId],
      });

      // 正开着这个会话：页面不能停在一个已经删掉的东西上。
      if (matchRoute({ to: "/sessions/$sessionId", params: { sessionId } })) {
        await navigate({ to: "/sessions" });
      }

      onOpenChange(null);
    },
  });

  const title = session?.title?.trim()
    ? session.title
    : t("sessions.untitled");

  function confirm(): void {
    if (session === null || removal.isPending) {
      return;
    }
    removal.mutate(session.id);
  }

  return (
    <AlertDialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) {
          removal.reset();
          onOpenChange(null);
        }
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("sessions.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("sessions.deleteDescription", { title })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {removal.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {getErrorMessage(removal.error)}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={removal.isPending}>
            {t("sessions.deleteCancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={removal.isPending}
            disabled={removal.isPending}
            onClick={confirm}
          >
            {t("sessions.deleteConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
