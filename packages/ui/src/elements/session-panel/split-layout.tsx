/**
 * 视图的左右分栏，以及右栏的收起。
 *
 * 两个视图的骨架是同一份：左边是内容，右边是树，中间可以拖，树可以整体收起
 * 但保持挂载——收起只折叠那一栏，树里的展开状态、选中和滚动位置都留着，展开
 * 时原样回来。骨架和收起规则写在一处，两个视图之间就不会慢慢分叉。
 */
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@workspace/ui/components/resizable";
import * as React from "react";
import type { RefObject } from "react";
import { usePanelRef } from "react-resizable-panels";
import type { PanelImperativeHandle } from "react-resizable-panels";

export type SplitLayoutProps = {
  /** 左侧内容；滚动容器由组件提供，这里只给内容。 */
  readonly left: React.ReactNode;
  /** 右侧树栏的内容。 */
  readonly tree: React.ReactNode;
  readonly showTree: boolean;
  /** 由 `useTreePanel` 给出。 */
  readonly treeRef: RefObject<PanelImperativeHandle | null>;
};

/**
 * 把 `showTree` 接到右侧那栏的展开与折叠上。
 *
 * @param showTree - 树是否显示。
 * @returns 交给 `SplitLayout` 的 `treeRef`。
 */
export function useTreePanel(showTree: boolean) {
  const treeRef = usePanelRef();

  React.useEffect(() => {
    const panel = treeRef.current;
    if (panel === null) {
      return;
    }
    if (showTree) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [showTree, treeRef]);

  return treeRef;
}

export function SplitLayout({
  left,
  showTree,
  tree,
  treeRef,
}: SplitLayoutProps) {
  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize={320} minSize={160}>
        <div className="flex h-full min-w-0 flex-col">
          {/* 正文再长也不参与高度：`contain: size` 让这一格的尺寸只由 flex
            决定，长内容才不会把面板和它外面整条高度链一起撑高。 */}
          <div className="min-h-0 flex-1 overflow-auto contain-[size]">
            {left}
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle
        className={showTree ? undefined : "hidden"}
        variant="gutter"
      />
      <ResizablePanel
        collapsedSize={0}
        collapsible
        defaultSize={208}
        maxSize={420}
        minSize={160}
        panelRef={treeRef}
      >
        <div className="flex h-full min-w-0 flex-col" inert={!showTree}>
          {tree}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
