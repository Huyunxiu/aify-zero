import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import {
  createFileRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { getErrorMessage } from "@workspace/shared/errors";
import { BotAvatar } from "@workspace/ui/blocks/bot-avatar";
import { BOT_SECTIONS } from "@workspace/ui/blocks/bots/bot-sections";
import { BotSettingsProvider } from "@workspace/ui/blocks/bots/bot-settings-context";
import type { BotUpdateInput } from "@workspace/ui/blocks/bots/types";
import { Island, IslandGroup } from "@workspace/ui/blocks/island";
import { DesktopTitleBar } from "@workspace/ui/blocks/title-bar";
import { Button } from "@workspace/ui/components/button";
import { Dialog, DialogContent } from "@workspace/ui/components/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@workspace/ui/components/sidebar";
import { Spinner } from "@workspace/ui/components/spinner";
import { toastManager } from "@workspace/ui/components/toast";
import { isDesktopShell } from "@workspace/ui/lib/desktop";
import { client } from "@workspace/ui/lib/orpc";
import { COVERS_SESSION } from "@workspace/ui/lib/route-static-data";
import { ChevronLeft } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

/**
 * One Bot's settings, drawn over the session.
 *
 * The dialog is built here rather than in each section: swapping sections swaps
 * the outlet, so the focus trap and the background lock never rebuild.
 */
const BotSettingsLayout = () => {
  const { botId } = Route.useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // `useRouter` is untyped until the app registers its router; the annotation
  // turns its history back into something a reader can call.
  const { history }: { history: RouterHistory } = useRouter();
  const matchRoute = useMatchRoute();

  // The history entry that opened this Bot. Sections are pushed on top of it, so
  // closing has to step over all of them: one step back per section would land
  // the reader on the previous section instead of the app.
  const index = useRouterState({
    select: (state) => state.location.state.__TSR_index,
  });
  const entryIndex = React.useRef(index);

  const close = (): void => {
    const steps = index - entryIndex.current + 1;

    if (history.canGoBack() && steps > 0) {
      history.go(-steps);

      return;
    }

    // A visit that starts at a section has nothing behind it.
    void navigate({ replace: true, to: "/sessions" });
  };

  const botQuery = useQuery({
    queryKey: ["bot", botId],
    queryFn: async () => await client.bot.get({ botId }),
  });

  const updateMutation = useMutation({
    mutationFn: async (patch: BotUpdateInput) =>
      await client.bot.update({ botId, ...patch }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bot", botId] }),
        queryClient.invalidateQueries({ queryKey: ["list_bots"] }),
        queryClient.invalidateQueries({ queryKey: ["listSessionResources"] }),
      ]);
    },
    onError: (error) => {
      toastManager.add({
        title: t("requestFailed"),
        description: getErrorMessage(error),
        type: "error",
      });
    },
  });

  const handleUpdate = async (patch: BotUpdateInput) => {
    await updateMutation.mutateAsync(patch);
  };

  const bot = botQuery.data?.bot;

  const renderContent = () => {
    if (botQuery.isPending) {
      return (
        <div className="flex h-48 items-center justify-center">
          <Spinner />
        </div>
      );
    }

    if (botQuery.isError || !bot) {
      return (
        <div className="mx-auto flex w-2xl flex-col items-start gap-3">
          <p className="text-destructive text-sm">
            {botQuery.isError
              ? getErrorMessage(botQuery.error)
              : t("bots.notFound")}
          </p>
          <Button variant="outline" size="sm" onClick={close}>
            {t("bots.backToApp")}
          </Button>
        </div>
      );
    }

    return (
      <BotSettingsProvider
        value={{
          bot,
          isSaving: updateMutation.isPending,
          onUpdate: handleUpdate,
        }}
      >
        <Outlet />
      </BotSettingsProvider>
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent
        className="h-screen max-h-none w-screen overflow-hidden rounded-none bg-sidebar p-0 sm:max-w-none"
        showCloseButton={false}
      >
        <SidebarProvider className="items-start">
          <Sidebar>
            <SidebarHeader className="gap-3 py-0">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={close}>
                    <ChevronLeft />
                    <span>{t("bots.backToApp")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
              {bot ? (
                <div className="flex items-center gap-2.5 px-2 pb-1">
                  <BotAvatar
                    avatarPath={bot.avatarPath}
                    botId={bot.id}
                    name={bot.name}
                    size="md"
                    version={bot.updatedAt}
                  />
                  <span className="truncate font-medium text-sm">
                    {bot.name}
                  </span>
                </div>
              ) : null}
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {BOT_SECTIONS.map((item) => (
                      <SidebarMenuItem key={item.key}>
                        <SidebarMenuButton
                          isActive={Boolean(
                            matchRoute({ to: item.to, params: { botId } })
                          )}
                          onClick={() => {
                            void navigate({ to: item.to, params: { botId } });
                          }}
                        >
                          <item.icon />
                          <span>{t(item.titleKey)}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <SidebarInset className="h-full bg-transparent">
            <IslandGroup orientation="horizontal">
              <Island
                className={isDesktopShell ? undefined : "pt-4"}
                defaultSize="100%"
              >
                <div className="flex h-full flex-col">
                  <DesktopTitleBar className="sticky top-0 flex h-14 items-center gap-2 px-3" />
                  <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-12">
                    {renderContent()}
                  </div>
                </div>
              </Island>
            </IslandGroup>
          </SidebarInset>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
};

export const Route = createFileRoute("/_shell/bots/$botId")({
  staticData: COVERS_SESSION,
  component: BotSettingsLayout,
});
