/**
 * 面板的新标签页。
 *
 * 面板没有标签时显示，由用户选一个要打开的视图。选完这个页面就换成对应
 * 视图；所有标签关闭后，面板下次打开又回到这里。
 */
import { Button } from "@workspace/ui/components/button";
import { FolderIcon } from "@workspace/ui/components/folder-icon";
import { FileDiffIcon, SquareTerminalIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { SessionPanelTab } from "../session-panel";

export type NewTabViewProps = {
  /** 打开一个视图标签。 */
  readonly onCreate: (tab: SessionPanelTab) => void;
};

export function NewTabView({ onCreate }: NewTabViewProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          onClick={() => {
            onCreate("files");
          }}
          size="lg"
          variant="outline"
        >
          <FolderIcon size={16} />
          {t("panel.tabs.files")}
        </Button>
        <Button
          onClick={() => {
            onCreate("review");
          }}
          size="lg"
          variant="outline"
        >
          <FileDiffIcon className="size-4" />
          {t("panel.tabs.review")}
        </Button>
        <Button
          onClick={() => {
            onCreate("terminal");
          }}
          size="lg"
          variant="outline"
        >
          <SquareTerminalIcon className="size-4" />
          {t("panel.tabs.terminal")}
        </Button>
      </div>
    </div>
  );
}
