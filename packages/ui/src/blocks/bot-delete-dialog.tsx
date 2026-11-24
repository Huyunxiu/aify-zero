import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import { getErrorMessage } from "@workspace/shared/errors";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog";
import { Checkbox } from "@workspace/ui/components/checkbox";
import { Label } from "@workspace/ui/components/label";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { client } from "../lib/orpc";

export type DeletableBot = {
  id: string;
  name: string;
  homeDir?: string;
};

type BotDeleteDialogProps = {
  bot: DeletableBot | null;
  onOpenChange: (bot: DeletableBot | null) => void;
};

/** Confirm deleting a Bot and optionally its on-disk Bot Home directory. */
export function BotDeleteDialog({ bot, onOpenChange }: BotDeleteDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const params: Record<string, unknown> = useParams({ strict: false });
  const [deleteFiles, setDeleteFiles] = useState(false);

  const removal = useMutation({
    mutationFn: (input: { botId: string; deleteFiles: boolean }) =>
      client.bot.delete(input),
    onSuccess: async (result, variables) => {
      const deletedSessionSet = new Set(result.deletedSessionIds);

      await queryClient.invalidateQueries({ queryKey: ["list_bots"] });
      await queryClient.invalidateQueries({ queryKey: ["list_sessions"] });
      queryClient.removeQueries({ queryKey: ["bot", variables.botId] });
      queryClient.removeQueries({ queryKey: ["bot-skills", variables.botId] });
      queryClient.removeQueries({
        queryKey: ["bot-mcp-status", variables.botId],
      });

      for (const sessionId of deletedSessionSet) {
        queryClient.removeQueries({ queryKey: ["getSession", sessionId] });
        queryClient.removeQueries({
          queryKey: ["listSessionTurns", sessionId],
        });
        queryClient.removeQueries({
          queryKey: ["listSessionResources", sessionId],
        });
      }

      // Fuzzy: every section of the Bot is its own address under the same layout,
      // so an exact match would miss a reader who is in one of them.
      const viewingBot = Boolean(
        matchRoute({
          to: "/bots/$botId",
          params: { botId: variables.botId },
          fuzzy: true,
        })
      );
      const currentSessionId =
        typeof params.sessionId === "string" ? params.sessionId : undefined;
      const viewingDeletedSession =
        currentSessionId !== undefined &&
        deletedSessionSet.has(currentSessionId);

      setDeleteFiles(false);
      onOpenChange(null);

      if (viewingBot || viewingDeletedSession) {
        await navigate({ to: "/sessions" });
      }
    },
  });

  const confirm = () => {
    if (bot === null || removal.isPending) {
      return;
    }
    removal.mutate({ botId: bot.id, deleteFiles });
  };

  return (
    <AlertDialog
      open={bot !== null}
      onOpenChange={(open) => {
        if (!open) {
          setDeleteFiles(false);
          removal.reset();
          onOpenChange(null);
        }
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("bots.deleteDialog.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("bots.deleteDialog.description", { name: bot?.name ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <Checkbox
              id="bot-delete-files"
              checked={deleteFiles}
              disabled={removal.isPending}
              onCheckedChange={(checked) => {
                setDeleteFiles(checked);
              }}
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor="bot-delete-files" className="cursor-pointer">
                {t("bots.deleteDialog.deleteFiles")}
              </Label>
              {bot?.homeDir ? (
                <span className="break-all font-mono text-muted-foreground text-xs">
                  {bot.homeDir}
                </span>
              ) : null}
            </div>
          </div>

          {removal.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {getErrorMessage(removal.error)}
            </p>
          ) : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={removal.isPending}>
            {t("bots.actions.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={removal.isPending}
            disabled={removal.isPending}
            onClick={confirm}
          >
            {t("bots.actions.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
