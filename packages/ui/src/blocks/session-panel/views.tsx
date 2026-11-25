/**
 * What each view of the panel is called and drawn as.
 *
 * Two tables and one set of names. A view added to `SessionPanelView` fails to
 * compile until it appears in both tables, so the icon and the label of every
 * view are answered in one place. The third thing a new view needs is its own
 * branch in `TabContent`, which ends in an exhaustive check.
 */
import { FolderIcon } from "@workspace/ui/blocks/folder-icon";
import { fileNameOf } from "@workspace/ui/lib/workspace-path";
import type { TFunction } from "i18next";
import {
  BotIcon,
  FileDiffIcon,
  PlusIcon,
  SquareTerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { PanelTab, SessionPanelView } from "./tabs";

/** The icon of each view. A new view adds one line here. */
export const TAB_ICONS: Record<SessionPanelView, ReactNode> = {
  files: <FolderIcon size={14} />,
  review: <FileDiffIcon size={14} />,
  subagent: <BotIcon className="size-3.5" />,
  terminal: <SquareTerminalIcon size={14} />,
};

/**
 * The label message of each view.
 *
 * A files tab and a subagent tab carry their own name, so their entry here is
 * the fallback: a tab that has lost its state still has a word.
 */
export const TAB_LABEL_KEYS = {
  files: "panel.tabs.files",
  review: "panel.tabs.review",
  subagent: "panel.tabs.subagent",
  terminal: "panel.tabs.terminal",
} as const satisfies Record<SessionPanelView, string>;

/**
 * The views the new-tab page can create.
 *
 * A subagent is not one of them: its view needs a session id, and that page has
 * no way to ask for one. The only way into a subagent record is the `task` row
 * that started it.
 */
export const PICKABLE_VIEWS = [
  "files",
  "review",
  "terminal",
] as const satisfies readonly SessionPanelView[];

type TabDescription = {
  readonly closeLabel: string;
  readonly icon: ReactNode;
  readonly label: string;
};

/**
 * The name of one tab.
 *
 * A files tab says which file is open, and falls back to the name of the
 * workspace root. A subagent tab says what that `task` call asked for. Every
 * other tab says what its view is called.
 *
 * @param tab - The tab.
 * @param t - The translation function.
 * @returns The name of the tab.
 */
function tabLabel(tab: PanelTab, t: TFunction): string {
  if (tab.view === null) {
    return t("panel.tabs.new");
  }

  if (tab.view === "subagent") {
    return tab.subagent?.title ?? t(TAB_LABEL_KEYS.subagent);
  }

  if (tab.view !== "files") {
    return t(TAB_LABEL_KEYS[tab.view]);
  }

  const path = tab.files?.target?.path ?? null;

  if (path !== null) {
    return fileNameOf(path);
  }

  return tab.files?.rootName ?? t(TAB_LABEL_KEYS.files);
}

/**
 * The icon, the name, and the close prompt of one tab.
 *
 * @param tab - The tab.
 * @param t - The translation function.
 * @returns The icon, the name, and the close prompt.
 */
export function describeTab(tab: PanelTab, t: TFunction): TabDescription {
  const label = tabLabel(tab, t);

  return {
    closeLabel:
      tab.view === null
        ? t("panel.closeNewTab")
        : t("panel.closeTab", { name: label }),
    icon: tab.view === null ? <PlusIcon size={14} /> : TAB_ICONS[tab.view],
    label,
  };
}
