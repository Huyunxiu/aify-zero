/**
 * 面板里的新标签页。
 *
 * 选中它时由用户选一个要打开的视图。选完这个标签页就换成对应视图；所有
 * 标签关闭后，面板下次打开又回到这里。
 */
import { Button } from "@workspace/ui/components/button";
import { FolderIcon } from "@workspace/ui/components/folder-icon";
import { FileDiffIcon, GlobeIcon, SquareTerminalIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getBrowserRuntime } from "./browser-runtime";
import type { SessionPanelView } from "./tabs";

export type NewTabViewProps = {
  /** 打开一个视图标签。 */
  readonly onCreate: (view: SessionPanelView) => void;
};

export function NewTabView({ onCreate }: NewTabViewProps) {
  const { t } = useTranslation();
  // 浏览器视图由桌面壳托管，Web 版没有入口。
  const hasBrowser = getBrowserRuntime() !== null;

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
        {hasBrowser && (
          <Button
            onClick={() => {
              onCreate("browser");
            }}
            size="lg"
            variant="outline"
          >
            <GlobeIcon className="size-4" />
            {t("panel.tabs.browser")}
          </Button>
        )}
      </div>
    </div>
  );
}
