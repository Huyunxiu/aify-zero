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
import { TitleBar } from "@workspace/ui/elements/title-bar";
import { ChevronLeft, UserCog, Palette } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AppearanceSettings } from "./appearance-settings";
import { GeneralSettings } from "./general-settings";

const data = {
  nav: [
    {
      key: "general",
      titleKey: "settings.general.title" as const,
      icon: UserCog,
    },
    {
      key: "appearance",
      titleKey: "settings.appearance.title" as const,
      icon: Palette,
    },
  ],
};

export type SettingsProps = {
  onClose: () => void;
};

export const Settings = ({ onClose }: SettingsProps) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState("general");
  return (
    <SidebarProvider className="items-start">
      <Sidebar>
        <SidebarHeader className="py-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onClose}>
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
                {data.nav.map((item) => (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      isActive={item.key === activeTab}
                      onClick={() => {
                        setActiveTab(item.key);
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
      <SidebarInset className="h-full">
        <IslandGroup orientation="horizontal">
          <Island defaultSize="50%">
            <TitleBar className="sticky top-0 flex h-14 items-center gap-2 bg-background px-3" />
            {activeTab === "appearance" && <AppearanceSettings />}
            {activeTab === "general" && <GeneralSettings />}
          </Island>
        </IslandGroup>
      </SidebarInset>
    </SidebarProvider>
  );
};
