import type { RouterHistory } from "@tanstack/react-router";
import {
  createFileRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
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
import { Island, IslandGroup } from "@workspace/ui/elements/island";
import { DesktopTitleBar } from "@workspace/ui/elements/title-bar";
import { isDesktopShell } from "@workspace/ui/lib/desktop";
import { COVERS_SESSION } from "@workspace/ui/lib/route-static-data";
import { ChevronLeft, Package, Palette, Plug, UserCog } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Every section of settings, in the order the sidebar shows them.
 *
 * A section is a route, not a tab: its address is the one a reader can send to
 * someone else, and the back button walks them one by one.
 */
const SECTIONS = [
  {
    icon: UserCog,
    titleKey: "settings.general.title" as const,
    to: "/settings/general" as const,
  },
  {
    icon: Palette,
    titleKey: "settings.appearance.title" as const,
    to: "/settings/appearance" as const,
  },
  {
    icon: Package,
    titleKey: "settings.provider.title" as const,
    to: "/settings/provider" as const,
  },
  {
    icon: Plug,
    titleKey: "settings.mcp.title" as const,
    to: "/settings/mcp" as const,
  },
];

/**
 * Settings, drawn over the session.
 *
 * The dialog is built here rather than in each section: swapping sections
 * swaps the outlet, so the focus trap and the background lock never rebuild.
 */
const SettingsLayout = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // `useRouter` is untyped until the app registers its router; the annotation
  // turns its history back into something a reader can call.
  const { history }: { history: RouterHistory } = useRouter();
  const matchRoute = useMatchRoute();

  // Back to whatever was on screen. A visit that starts here has nothing to go
  // back to, so it lands on the session list instead.
  const close = (): void => {
    if (history.canGoBack()) {
      history.back();

      return;
    }

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
                    {SECTIONS.map((item) => (
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

export const Route = createFileRoute("/_shell/settings")({
  staticData: COVERS_SESSION,
  component: SettingsLayout,
});
