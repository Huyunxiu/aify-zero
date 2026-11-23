import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar";
import { Bolt } from "lucide-react";
import { useTranslation } from "react-i18next";

export function NavBottom() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const { t } = useTranslation();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={Boolean(matchRoute({ fuzzy: true, to: "/settings" }))}
          onClick={() => {
            void navigate({ to: "/settings" });
          }}
        >
          <Bolt strokeWidth={1.5} />
          <span>{t("settings.title")}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
