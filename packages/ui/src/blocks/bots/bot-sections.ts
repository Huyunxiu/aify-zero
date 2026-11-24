import { redirect } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import {
  BotIcon,
  BrainCircuitIcon,
  PlugIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";

export type BotSectionKey = "general" | "model" | "skills" | "mcp" | "runtime";

/** The address of a Bot section. The Bot id fills the `$botId` segment. */
export type BotSectionPath = `/bots/$botId/settings/${BotSectionKey}`;

export type BotSection = {
  readonly key: BotSectionKey;
  readonly icon: LucideIcon;
  readonly titleKey: `bots.sections.${BotSectionKey}`;
  readonly to: BotSectionPath;
};

/**
 * Every section of one Bot, in the order the sidebar shows them.
 *
 * A section is a route, not a tab: its address is the one a reader can send to
 * someone else, and the back button walks them one by one.
 */
export const BOT_SECTIONS: readonly BotSection[] = [
  {
    key: "general",
    icon: BotIcon,
    titleKey: "bots.sections.general",
    to: "/bots/$botId/settings/general",
  },
  {
    key: "model",
    icon: BrainCircuitIcon,
    titleKey: "bots.sections.model",
    to: "/bots/$botId/settings/model",
  },
  {
    key: "skills",
    icon: SparklesIcon,
    titleKey: "bots.sections.skills",
    to: "/bots/$botId/settings/skills",
  },
  {
    key: "mcp",
    icon: PlugIcon,
    titleKey: "bots.sections.mcp",
    to: "/bots/$botId/settings/mcp",
  },
  {
    key: "runtime",
    icon: ShieldCheckIcon,
    titleKey: "bots.sections.runtime",
    to: "/bots/$botId/settings/runtime",
  },
];

/** The section the two section-less addresses hand the reader to. */
export const FIRST_BOT_SECTION = BOT_SECTIONS[0]!.to;

/**
 * Hand a reader who named no section to the first one.
 *
 * Two addresses name no section: the bare Bot address, and `/bots/$botId/settings`.
 * Both say this, so one place says it for both.
 */
export function redirectToFirstBotSection(params: { botId: string }): never {
  // The router uses a thrown redirect as control flow, not as an error.
  // oxlint-disable-next-line typescript/only-throw-error
  throw redirect({ replace: true, to: FIRST_BOT_SECTION, params });
}
