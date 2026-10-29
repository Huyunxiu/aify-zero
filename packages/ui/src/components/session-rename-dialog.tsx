import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage } from "@workspace/shared/errors";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc";
import { Button } from "./button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Field } from "./field";
import { Input } from "./input";

/** 重命名只需要这两个字段，列表里拿到的会话够用。 */
export type RenamableSession = {
  id: string;
  title: string | null;
};

type SessionRenameDialogProps = {
  /** `null` 表示关闭；传会话就是打开并编辑它。 */
  session: RenamableSession | null;
  onOpenChange: (session: RenamableSession | null) => void;
};

/** 会话行菜单里的「重命名」：只改标题，不碰会话内容。 */
export function SessionRenameDialog({
  session,
  onOpenChange,
}: SessionRenameDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");

  // 每次打开都从当前标题重新填，避免上一轮的输入串到别的会话上。
  useEffect(() => {
    if (session) {
      setTitle(session.title ?? "");
    }
  }, [session]);

  const renameMutation = useMutation({
    mutationFn: (input: { sessionId: string; title: string }) =>
      client.session.updateSession(input),
    onSuccess: async () => {
      // 项目下的会话列表用同一个前缀，一起失效。
      await queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
      onOpenChange(null);
    },
  });

  const trimmedTitle = title.trim();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !trimmedTitle || renameMutation.isPending) {
      return;
    }
    renameMutation.mutate({ sessionId: session.id, title: trimmedTitle });
  }

  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) {
          onOpenChange(null);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t("sessions.renameTitle")}
          </DialogTitle>
        </DialogHeader>

        <form id="session-rename-form" onSubmit={handleSubmit} noValidate>
          <Field>
            <Input
              id="session-rename-title"
              name="title"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              placeholder={t("sessions.renamePlaceholder")}
              autoComplete="off"
              autoFocus
            />
          </Field>
        </form>

        {renameMutation.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {getErrorMessage(renameMutation.error)}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose
            render={
              <Button
                type="button"
                variant="outline"
                disabled={renameMutation.isPending}
              />
            }
          >
            {t("sessions.renameCancel")}
          </DialogClose>
          <Button
            type="submit"
            form="session-rename-form"
            loading={renameMutation.isPending}
            disabled={renameMutation.isPending || !trimmedTitle}
          >
            {t("sessions.renameSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
