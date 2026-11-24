import type { LucideIcon } from "lucide-react";
import { Package, Palette, Plug, UserCog } from "lucide-react";

export type SettingsSection = {
  readonly icon: LucideIcon;
  readonly titleKey:
    | "settings.general.title"
    | "settings.appearance.title"
    | "settings.provider.title"
    | "settings.mcp.title";
  readonly to:
    | "/settings/general"
    | "/settings/appearance"
    | "/settings/provider"
    | "/settings/mcp";
};

/**
 * Every section of settings, in the order the sidebar shows them.
 *
 * A section is a route, not a tab: its address is the one a reader can send to
 * someone else, and the back button walks them one by one.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    icon: UserCog,
    titleKey: "settings.general.title",
    to: "/settings/general",
  },
  {
    icon: Palette,
    titleKey: "settings.appearance.title",
    to: "/settings/appearance",
  },
  {
    icon: Package,
    titleKey: "settings.provider.title",
    to: "/settings/provider",
  },
  {
    icon: Plug,
    titleKey: "settings.mcp.title",
    to: "/settings/mcp",
  },
];

/** The section that owns the plain `/settings` address. */
export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0]!.to;
