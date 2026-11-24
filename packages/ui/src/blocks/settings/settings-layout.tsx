import type { RouterHistory } from "@tanstack/react-router";
import {
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { Island, IslandGroup } from "@workspace/ui/blocks/island";
import { SETTINGS_SECTIONS } from "@workspace/ui/blocks/settings/sections";
import { DesktopTitleBar } from "@workspace/ui/blocks/title-bar";
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
import { isDesktopShell } from "@workspace/ui/lib/desktop";
import { ChevronLeft } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

/**
 * Settings, drawn over the session.
 *
 * The dialog is built here rather than in each section: swapping sections
 * swaps the outlet, so the focus trap and the background lock never rebuild.
 */
export const SettingsLayout = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // `useRouter` is untyped until the app registers its router; the annotation
  // turns its history back into something a reader can call.
  const { history }: { history: RouterHistory } = useRouter();
  const matchRoute = useMatchRoute();

  // The history entry that opened settings. Sections are pushed on top of it, so
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
            <SidebarHeader className="py-0">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={close}>
                    <ChevronLeft />
                    <span>{t("settings.backToApp")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {SETTINGS_SECTIONS.map((item) => (
                      <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton
                          isActive={Boolean(matchRoute({ to: item.to }))}
                          onClick={() => {
                            void navigate({ to: item.to });
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
                <DesktopTitleBar className="sticky top-0 flex h-14 items-center gap-2 px-3" />
                <Outlet />
              </Island>
            </IslandGroup>
          </SidebarInset>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
};
