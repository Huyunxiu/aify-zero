/**
 * 会话右侧的面板。
 *
 * 头部最左是标签栏，列出已打开的视图；下方是当前视图自己的区域。这一期只有
 * 文件视图，终端、浏览器等以后按同样的模式加：标签加进 `SessionPanelTab`，
 * 区域写成同级目录下的视图组件。
 */
import { Button } from "@workspace/ui/components/button";
import { FolderIcon } from "@workspace/ui/components/folder-icon";
import {
  TabStripList,
  TabStripTrigger,
  Tabs,
  TabsContent,
} from "@workspace/ui/components/tabs";
import { TitleBar } from "@workspace/ui/elements/title-bar";
import { PanelRightIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { FilesView } from "./session-panel/files-view";

export type SessionPanelTab = "files";

export type SessionPanelProps = {
  readonly sessionId: string;
  /** 关闭面板。入口按钮在会话头部，面板打开时它不再画。 */
  readonly onClose: () => void;
};

/**
 * 一个会话的右侧面板。
 *
 * @param props.sessionId - 决定可访问的会话；换会话时由调用方重新挂载。
 */
export function SessionPanel({ sessionId, onClose }: SessionPanelProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = React.useState<SessionPanelTab>("files");
  const [activeFile, setActiveFile] = React.useState<string | null>(null);
  const [rootName, setRootName] = React.useState<string | null>(null);

  // 标签写当前文件名；没有打开文件就看工作区根目录名。
  const tabLabel =
    activeFile === null
      ? (rootName ?? t("panel.tabs.files"))
      : activeFile.slice(activeFile.lastIndexOf("/") + 1);

  return (
    <Tabs
      className="flex h-full min-h-0 flex-col gap-0"
      onValueChange={(value) => setActiveTab(value as SessionPanelTab)}
      value={activeTab}
    >
      <TitleBar className="sticky top-0 flex h-12 shrink-0 items-center gap-1 border-b pl-2 pr-4">
        <TabStripList className="[-webkit-app-region:no-drag]">
          <TabStripTrigger
            closeLabel={t("panel.closeTab", { name: tabLabel })}
            icon={<FolderIcon size={14} />}
            onClose={onClose}
            value="files"
          >
            {tabLabel}
          </TabStripTrigger>
        </TabStripList>
        <Button
          aria-label={t("panel.close")}
          className="[-webkit-app-region:no-drag] shrink-0"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <PanelRightIcon className="size-4" />
        </Button>
      </TitleBar>
      {/* 切走的视图只隐藏，不卸载：树的状态、终端进程要留到切回来。 */}
      <TabsContent
        className="min-h-0 flex-1 overflow-hidden"
        keepMounted
        value="files"
      >
        <FilesView
          activeFile={activeFile}
          onActiveFileChange={setActiveFile}
          onRootNameChange={setRootName}
          rootName={rootName}
          sessionId={sessionId}
        />
      </TabsContent>
    </Tabs>
  );
}
