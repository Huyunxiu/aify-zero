/**
 * 会话右侧的面板。
 *
 * 头部最左是标签栏，列出已打开的标签；下方是当前标签自己的区域。标签是实例，
 * 不是视图类型：同一个视图可以开多个标签，文件标签各自记住打开的文件。没有
 * 可用标签时用「新标签页」选一个视图，标签栏右边的 + 按钮可以再开一个。关闭
 * 标签只卸载对应视图，所有标签都关掉才收起整个面板。
 *
 * 以后加浏览器等视图也走同一个模式：视图加进 `SessionPanelView`，图标和
 * 文案各加一行，区域写成同级目录下的视图组件。
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
import { fileNameOf } from "@workspace/ui/lib/workspace-path";
import type { TFunction } from "i18next";
import {
  FileDiffIcon,
  PanelRightIcon,
  PlusIcon,
  SquareTerminalIcon,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import type { FileOpenTarget } from "../markdown-link";
import { FilesView } from "./files-view";
import { NewTabView } from "./new-tab-view";
import { ReviewView } from "./review-view";
import { initialPanelState, panelReducer } from "./tabs";
import type { PanelAction, PanelTab, SessionPanelView } from "./tabs";
import { TerminalView } from "./terminal-view";

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
  readonly openRequest?: FileOpenTarget;
};

/** 一个标签的图标、标题和关闭提示。 */
type TabDescription = {
  readonly closeLabel: string;
  readonly icon: React.ReactNode;
  readonly label: string;
};

/** 每个视图的图标：加视图时在这一张表里加一行。 */
const TAB_ICONS: Record<SessionPanelView, React.ReactNode> = {
  files: <FolderIcon size={14} />,
  review: <FileDiffIcon size={14} />,
  terminal: <SquareTerminalIcon size={14} />,
};

/** 每个视图的标题文案键；文件视图的标题跟着打开的文件变，单独算。 */
const TAB_LABEL_KEYS: Record<SessionPanelView, string> = {
  files: "panel.tabs.files",
  review: "panel.tabs.review",
  terminal: "panel.tabs.terminal",
};

/**
 * 一个标签的标题。
 *
 * 文件标签写当前打开的文件名；没有打开文件就看工作区根目录名。
 *
 * @param tab - 标签。
 * @param t - 翻译函数。
 * @returns 标签标题。
 */
function tabLabel(tab: PanelTab, t: TFunction): string {
  if (tab.view === null) {
    return t("panel.tabs.new");
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
 * 一个标签的图标、标题和关闭提示。
 *
 * @param tab - 标签。
 * @param t - 翻译函数。
 * @returns 图标、标题和关闭提示。
 */
function describeTab(tab: PanelTab, t: TFunction): TabDescription {
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
  const idCounter = React.useRef(0);
  // id 只在当前面板里唯一；计数器跟着组件实例走，重新挂载时不会和旧 id 冲突。
  const nextId = React.useCallback((): string => {
    idCounter.current += 1;
    return `tab-${idCounter.current}`;
  }, []);
  const [panel, dispatch] = React.useReducer(panelReducer, undefined, () =>
    initialPanelState(nextId())
  );

  // 聊天里的文件链接：当前标签是文件视图就打开在它里面，否则用最早打开的
  // 文件标签；都没有就新开一个。展开面板本身由会话层负责。
  React.useEffect(() => {
    if (openRequest === undefined) {
      return;
    }

    dispatch({ id: nextId(), request: openRequest, type: "openFile" });
  }, [openRequest, nextId]);

  /** 增加一个新标签页；已经有一个时只切过去。 */
  const addTab = (): void => {
    dispatch({ id: nextId(), type: "addTab" });
  };

  const closeTab = (id: string): void => {
    if (panel.tabs.length === 1) {
      // 最后一个标签关闭后收起整个面板；下次打开回到新标签页。
      onClose();
    }

    dispatch({ id, type: "close" });
  };

  return (
    <Tabs
      className="flex h-full min-h-0 flex-col gap-0"
      onValueChange={(value) => {
        dispatch({ id: value, type: "select" });
      }}
      value={panel.activeId}
    >
      <TitleBar className="sticky top-0 flex h-12 shrink-0 items-center gap-1 border-b pl-2 pr-4">
        <TabStripList className="[-webkit-app-region:no-drag]">
          {panel.tabs.map((tab) => {
            const { closeLabel, icon, label } = describeTab(tab, t);

            return (
              <TabStripTrigger
                className="min-w-30"
                closeLabel={closeLabel}
                icon={icon}
                key={tab.id}
                onClose={() => {
                  closeTab(tab.id);
                }}
                value={tab.id}
              >
                {label}
              </TabStripTrigger>
            );
          })}
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
      {panel.tabs.map((tab) => (
        <TabContent
          active={open && panel.activeId === tab.id}
          dispatch={dispatch}
          key={tab.id}
          sessionId={sessionId}
          tab={tab}
        />
      ))}
    </Tabs>
  );
}

type TabContentProps = {
  /** 这个标签是不是当前标签，并且面板没有收起。 */
  readonly active: boolean;
  readonly dispatch: React.Dispatch<PanelAction>;
  readonly sessionId: string;
  readonly tab: PanelTab;
};

/** 一个标签的区域；内容按视图类型挂载。 */
function TabContent({ active, dispatch, sessionId, tab }: TabContentProps) {
  const className = "min-h-0 flex-1 overflow-hidden";

  if (tab.view === null) {
    return (
      <TabsContent className={className} value={tab.id}>
        <NewTabView
          onCreate={(view) => {
            // 新标签页自己变成选中的视图，id 不变。
            dispatch({ id: tab.id, type: "openView", view });
          }}
        />
      </TabsContent>
    );
  }

  if (tab.view === "files") {
    return (
      <TabsContent className={className} keepMounted value={tab.id}>
        <FilesTabContent dispatch={dispatch} sessionId={sessionId} tab={tab} />
      </TabsContent>
    );
  }

  if (tab.view === "review") {
    return (
      <TabsContent className={className} keepMounted value={tab.id}>
        <ReviewView active={active} sessionId={sessionId} />
      </TabsContent>
    );
  }

  return (
    <TabsContent className={className} keepMounted value={tab.id}>
      <TerminalView active={active} sessionId={sessionId} />
    </TabsContent>
  );
}

type FilesTabContentProps = {
  readonly dispatch: React.Dispatch<PanelAction>;
  readonly sessionId: string;
  readonly tab: PanelTab;
};

/** 文件标签的内容；回调和状态只属于这个标签。 */
function FilesTabContent({ dispatch, sessionId, tab }: FilesTabContentProps) {
  const { id } = tab;
  const selectFile = React.useCallback(
    (path: string | null) => {
      dispatch({ id, path, type: "selectFile" });
    },
    [dispatch, id]
  );
  const setRootName = React.useCallback(
    (name: string) => {
      dispatch({ id, name, type: "setRootName" });
    },
    [dispatch, id]
  );
  const { files } = tab;

  return (
    <FilesView
      onActiveFileChange={selectFile}
      onRootNameChange={setRootName}
      openRequest={files?.request}
      rootName={files?.rootName ?? null}
      sessionId={sessionId}
      target={files?.target ?? null}
    />
  );
}
