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
import type { BotSummary } from "@workspace/agent-client";
import { TitleBar } from "@workspace/ui/blocks/title-bar";
import { Button } from "@workspace/ui/components/button";
import {
  TabStripList,
  TabStripTrigger,
  Tabs,
  TabsContent,
} from "@workspace/ui/components/tabs";
import { PanelRightIcon, PlusIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import type { FileOpenTarget } from "../markdown-link";
import { FilesView } from "./files-view";
import { NewTabView } from "./new-tab-view";
import { ReviewView } from "./review-view";
import { SubagentView } from "./subagent-view";
import { initialPanelState, panelReducer } from "./tabs";
import type { PanelAction, PanelTab, SubagentTabState } from "./tabs";
import { TerminalView } from "./terminal-view";
import { describeTab } from "./views";

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
  /**
   * The Bot of the session.
   *
   * A subagent's row follows its parent, so this is the face that stands beside
   * every answer in the record too.
   */
  readonly bot?: BotSummary | null;
  /**
   * The subagent the address names.
   *
   * Every naming is a new object, so naming the same one again activates its tab
   * again instead of doing nothing.
   */
  readonly subagentRequest?: SubagentTabState;
  /**
   * A subagent's tab was closed.
   *
   * The panel does not touch the address: one reader owns it, and this reports
   * which tab went away.
   */
  readonly onSubagentDropped?: (sessionId: string) => void;
};

export function SessionPanel({
  bot,
  onClose,
  onSubagentDropped,
  open,
  openRequest,
  sessionId,
  subagentRequest,
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

  // The address names a subagent: build its tab and activate it. When its tab is
  // already open this only selects it, which is the reducer's rule of one tab per
  // subagent.
  React.useEffect(() => {
    if (subagentRequest === undefined) {
      return;
    }

    dispatch({
      id: nextId(),
      subagent: subagentRequest,
      type: "openSubagent",
    });
  }, [subagentRequest, nextId]);

  /** 增加一个新标签页；已经有一个时只切过去。 */
  const addTab = (): void => {
    dispatch({ id: nextId(), type: "addTab" });
  };

  const closeTab = (id: string): void => {
    const closing = panel.tabs.find((tab) => tab.id === id);

    if (panel.tabs.length === 1) {
      // 最后一个标签关闭后收起整个面板；下次打开回到新标签页。
      onClose();
    }

    dispatch({ id, type: "close" });

    if (closing?.subagent) {
      onSubagentDropped?.(closing.subagent.sessionId);
    }
  };

  // 已经有新标签页时，+ 按钮只会切过去，和它重复，所以不画。
  const hasNewTab = panel.tabs.some((tab) => tab.view === null);

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
          {!hasNewTab && (
            <Button
              aria-label={t("panel.addTab")}
              className="[-webkit-app-region:no-drag] shrink-0"
              onClick={addTab}
              size="icon-sm"
              variant="ghost"
            >
              <PlusIcon className="size-4" />
            </Button>
          )}
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
          bot={bot}
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
  readonly bot?: BotSummary | null;
  readonly dispatch: React.Dispatch<PanelAction>;
  readonly sessionId: string;
  readonly tab: PanelTab;
};

/** 一个标签的区域；内容按视图类型挂载。 */
function TabContent({
  active,
  bot,
  dispatch,
  sessionId,
  tab,
}: TabContentProps) {
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

  if (tab.view === "subagent") {
    // A subagent's record reads its own stream, so a change of tab must not stop
    // it.
    return (
      <TabsContent className={className} keepMounted value={tab.id}>
        {tab.subagent && (
          <SubagentView bot={bot} sessionId={tab.subagent.sessionId} />
        )}
      </TabsContent>
    );
  }

  if (tab.view === "terminal") {
    return (
      <TabsContent className={className} keepMounted value={tab.id}>
        <TerminalView active={active} sessionId={sessionId} />
      </TabsContent>
    );
  }

  // Every view has its own branch above. A view added without one fails to
  // compile here. This line used to be a bare `return`, so a missing branch drew
  // the terminal instead.
  const unhandled: never = tab.view;
  return unhandled;
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
