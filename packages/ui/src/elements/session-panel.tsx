/**
 * 会话右侧的面板。
 *
 * 头部最左是标签栏，列出已打开的视图；下方是当前视图自己的区域。标签按需
 * 创建：没有视图可开时用「新标签页」选一个视图，标签栏右边的 + 按钮可以再
 * 加一个新标签页。关闭标签只卸载对应视图，所有标签都关掉才收起整个面板。
 *
 * 以后加浏览器等视图也走同一个模式：标签加进 `SessionPanelTab`，区域写成
 * 同级目录下的视图组件。
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
import { PanelRightIcon, PlusIcon, SquareTerminalIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import type { FileOpenTarget } from "./markdown-link";
import { FilesView } from "./session-panel/files-view";
import { NewTabView } from "./session-panel/new-tab-view";
import { NEW_TAB, withView } from "./session-panel/tabs";
import type { PanelTabValue, SessionPanelTab } from "./session-panel/tabs";
import { TerminalView } from "./session-panel/terminal-view";

export type { SessionPanelTab } from "./session-panel/tabs";

export type SessionPanelProps = {
  /** 面板是否展开；收起时终端只暂停绘制，不卸载。 */
  readonly open: boolean;
  readonly sessionId: string;
  /** 收起面板。入口按钮在会话头部，面板打开时它不再画。 */
  readonly onClose: () => void;
  /**
   * 来自聊天里文件链接的打开请求。
   *
   * 每点一次链接都是一个新对象，所以重复点同一个文件也会重新定位。
   */
  readonly openRequest?: FileOpenTarget | null;
};

/**
 * 标签的图标：新标签页用加号，视图用各自的图标。
 *
 * @param tab - 标签值。
 * @returns 图标元素。
 */
function iconOf(tab: PanelTabValue): React.ReactNode {
  if (tab === NEW_TAB) {
    return <PlusIcon size={14} />;
  }

  return tab === "files" ? (
    <FolderIcon size={14} />
  ) : (
    <SquareTerminalIcon size={14} />
  );
}

/**
 * 一个会话的右侧面板。
 *
 * @param props.sessionId - 决定可访问的会话；换会话时由调用方重新挂载。
 */
export function SessionPanel({
  open,
  sessionId,
  onClose,
  openRequest,
}: SessionPanelProps) {
  const { t } = useTranslation();
  // 已打开的标签，按打开顺序排列；第一个标签页在面板第一次打开时就在。
  const [tabs, setTabs] = React.useState<PanelTabValue[]>([NEW_TAB]);
  const [activeTab, setActiveTab] = React.useState<PanelTabValue>(NEW_TAB);
  const [activeFile, setActiveFile] = React.useState<string | null>(null);
  const [rootName, setRootName] = React.useState<string | null>(null);

  // 聊天里的文件链接要面板做什么：切到文件标签、展开、定位。展开面板本身
  // 由会话层负责，这里只管标签和当前文件。
  React.useEffect(() => {
    if (openRequest === undefined || openRequest === null) {
      return;
    }

    setTabs((current) => withView(current, "files"));
    setActiveTab("files");
    setActiveFile(openRequest.path);
  }, [openRequest]);

  // 文件标签写当前文件名；没有打开文件就看工作区根目录名。
  const filesLabel =
    activeFile === null
      ? (rootName ?? t("panel.tabs.files"))
      : activeFile.slice(activeFile.lastIndexOf("/") + 1);

  const labelOf = (tab: PanelTabValue): string => {
    if (tab === NEW_TAB) {
      return t("panel.tabs.new");
    }

    return tab === "files" ? filesLabel : t("panel.tabs.terminal");
  };

  const closeLabelOf = (tab: PanelTabValue): string =>
    tab === NEW_TAB
      ? t("panel.closeNewTab")
      : t("panel.closeTab", { name: labelOf(tab) });

  /** 增加一个新标签页；已经有一个时只切过去。 */
  const addTab = (): void => {
    setTabs((current) =>
      current.includes(NEW_TAB) ? current : [...current, NEW_TAB]
    );
    setActiveTab(NEW_TAB);
  };

  /** 在新标签页里选一个视图：原地替换，选中的视图只保留一个标签。 */
  const chooseView = (view: SessionPanelTab): void => {
    setTabs((current) => withView(current, view));
    setActiveTab(view);
  };

  const closeTab = (tab: PanelTabValue): void => {
    const index = tabs.indexOf(tab);
    const remaining = tabs.filter((item) => item !== tab);

    if (tab === "files") {
      // 文件视图卸载后旧的选择一并清掉；再打开时从工作区根开始。
      setActiveFile(null);
      setRootName(null);
    }

    if (remaining.length === 0) {
      // 所有标签都关闭了，才收起整个面板；下次打开回到新标签页。
      setTabs([NEW_TAB]);
      setActiveTab(NEW_TAB);
      onClose();

      return;
    }

    setTabs(remaining);

    if (activeTab === tab) {
      const next = remaining[Math.min(index, remaining.length - 1)];

      if (next !== undefined) {
        setActiveTab(next);
      }
    }
  };

  return (
    <Tabs
      className="flex h-full min-h-0 flex-col gap-0"
      onValueChange={(value) => {
        setActiveTab(value as PanelTabValue);
      }}
      value={activeTab}
    >
      <TitleBar className="sticky top-0 flex h-12 shrink-0 items-center gap-1 border-b pl-2 pr-4">
        <TabStripList className="[-webkit-app-region:no-drag]">
          {tabs.map((tab) => (
            <TabStripTrigger
              closeLabel={closeLabelOf(tab)}
              icon={iconOf(tab)}
              key={tab}
              onClose={() => {
                closeTab(tab);
              }}
              value={tab}
            >
              {labelOf(tab)}
            </TabStripTrigger>
          ))}
          <Button
            aria-label={t("panel.addTab")}
            className="[-webkit-app-region:no-drag] shrink-0"
            onClick={addTab}
            size="icon-sm"
            variant="ghost"
          >
            <PlusIcon className="size-4" />
          </Button>
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
      {tabs.includes(NEW_TAB) ? (
        <TabsContent className="min-h-0 flex-1 overflow-hidden" value={NEW_TAB}>
          <NewTabView onCreate={chooseView} />
        </TabsContent>
      ) : null}
      {tabs.includes("files") ? (
        <TabsContent
          className="min-h-0 flex-1 overflow-hidden"
          keepMounted
          value="files"
        >
          <FilesView
            activeFile={activeFile}
            onActiveFileChange={setActiveFile}
            onRootNameChange={setRootName}
            reveal={openRequest ?? undefined}
            rootName={rootName}
            sessionId={sessionId}
          />
        </TabsContent>
      ) : null}
      {tabs.includes("terminal") ? (
        <TabsContent
          className="min-h-0 flex-1 overflow-hidden"
          keepMounted
          value="terminal"
        >
          <TerminalView
            active={open && activeTab === "terminal"}
            sessionId={sessionId}
          />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
