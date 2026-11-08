/**
 * 会话面板里的改动视图。
 *
 * 布局和文件视图一致：左边是内容，右边是改动列表。左边一次只画树里选中的那
 * 一个文件，换文件就重画；右边只列有改动的路径，状态用树自带的 git 标记。
 *
 * 数据以基线（`HEAD`）为准，已暂存和未暂存的改动不分开显示。视图只读：它不
 * 暂存、不丢弃、不提交，只回答「相对基线改了什么」。
 *
 * 「目录不是仓库」「文件不是文本」「文件超出上限」都在自己的区域里说明原因，
 * 不弹全局错误提示——它们是目录或文件的属性，不是请求失败。
 */
import type { CodeViewItem } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import {
  FileTree,
  useFileTree,
  useFileTreeSelection,
} from "@pierre/trees/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LOCAL_STORAGE_KEYS } from "@workspace/shared/constants";
import { getErrorMessage } from "@workspace/shared/errors";
import { Button } from "@workspace/ui/components/button";
import { HoverScrollText } from "@workspace/ui/components/hover-scroll-text";
import { InputCopyButton } from "@workspace/ui/components/input-copy-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@workspace/ui/components/segmented-control";
import { useTheme } from "@workspace/ui/components/theme-provider";
import { client } from "@workspace/ui/lib/orpc";
import { useContentVersion } from "@workspace/ui/lib/use-content-version";
import { isDirectoryPath } from "@workspace/ui/lib/workspace-path";
import { FolderTreeIcon, RefreshCwIcon, Settings2Icon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import type { DiffLayout } from "./code-preview";
import { CODE_VIEW_STYLE, codeViewOptions, diffLayoutOf } from "./code-preview";
import { selectOnlyPath, treeStyle } from "./file-tree";
import { Hint } from "./hint";
import { lineCountsOf, reviewItemOf, treeInputOf } from "./review-model";
import { SplitLayout, useTreePanel } from "./split-layout";

/** 差异排布的两个选项：取值、文案键、以及存储里的写法。 */
const LAYOUTS = [
  { label: "review.settings.stacked", value: "unified" },
  { label: "review.settings.split", value: "split" },
] as const satisfies readonly { label: string; value: DiffLayout }[];

export type ReviewViewProps = {
  /** 这个视图是不是当前标签；切回来时重新读一次改动。 */
  readonly active: boolean;
  readonly sessionId: string;
};

/**
 * 一个会话工作区的改动。
 *
 * @param props.sessionId - 决定可访问的根；换会话时由调用方重新挂载。
 */
export function ReviewView({ active, sessionId }: ReviewViewProps) {
  const { t } = useTranslation();
  const isDark = useTheme().resolvedTheme === "dark";
  const queryClient = useQueryClient();
  const { model } = useFileTree({
    paths: [],
    density: "default",
    icons: "complete",
    initialExpansion: "open",
  });
  const selected = useFileTreeSelection(model);

  const [path, setPath] = React.useState<string | null>(null);
  // 差异怎么排：跟着用户走，所以存在本地，下次打开还是这个。
  const [layout, setLayout] = React.useState<DiffLayout>(() =>
    diffLayoutOf(localStorage.getItem(LOCAL_STORAGE_KEYS.REVIEW_DIFF_LAYOUT))
  );
  // 目录默认显示；收起只折叠右侧那栏，不卸载，树的状态都留着。
  const [showTree, setShowTree] = React.useState(true);
  const treeRef = useTreePanel(showTree);

  const changes = useQuery({
    queryKey: ["review-changes", sessionId],
    queryFn: () => client.review.changes({ sessionId }),
    retry: false,
  });
  const diff = useQuery({
    queryKey: ["review-file", sessionId, path],
    queryFn: () => client.review.file({ sessionId, path: path ?? "" }),
    enabled: path !== null,
    retry: false,
  });

  // 左侧的条目只算一次：header 的行数和下面画的内容都用它。
  const loaded = diff.data;
  const version = useContentVersion(loaded);
  const item = React.useMemo(() => {
    if (loaded === undefined || loaded.kind !== "file") {
      return null;
    }
    return reviewItemOf(loaded, version);
  }, [loaded, version]);
  const counts = item?.type === "diff" ? lineCountsOf(item.fileDiff) : null;

  const { data } = changes;
  const changedPaths = data?.kind === "changes" ? data.changes : [];
  const unsupported = data?.kind === "unsupported" ? data.reason : null;
  // 同一份改动重复到达时（例如切回来重新读），不要把树的展开状态和选中清掉。
  const shownSignature = React.useRef<string | null>(null);
  // 重新铺路径会清掉树的选中，所以要先记住当前文件。用 ref 读它，免得把 path
  // 放进依赖里：那样每次选中都会重铺一遍树。
  const pathRef = React.useRef(path);

  React.useEffect(() => {
    pathRef.current = path;
  }, [path]);

  React.useEffect(() => {
    if (data === undefined || data.kind !== "changes") {
      return;
    }

    const { gitStatus, paths } = treeInputOf(data.changes);
    const signature = JSON.stringify(gitStatus);

    if (signature === shownSignature.current) {
      return;
    }

    shownSignature.current = signature;
    model.resetPaths(paths);
    model.setGitStatus(gitStatus);

    const { current } = pathRef;

    if (current === null) {
      return;
    }

    if (paths.includes(current)) {
      selectOnlyPath(model, current);
    } else {
      // 这个文件已经不在改动里了：左侧跟着清空，不留一份过期的内容。
      setPath(null);
    }
  }, [data, model]);

  // 树里选中的是目录就只展开；选中的是文件才画它的改动。
  const [current] = selected;
  React.useEffect(() => {
    if (current === undefined || isDirectoryPath(current)) {
      return;
    }
    setPath(current);
  }, [current]);

  // 切回这个标签时重新读一次：用户可能刚在别处改了文件。
  const refetchChanges = changes.refetch;
  const opened = React.useRef(active);
  React.useEffect(() => {
    if (!active) {
      opened.current = false;
      return;
    }
    if (opened.current) {
      return;
    }
    opened.current = true;
    void refetchChanges();
    void queryClient.invalidateQueries({
      queryKey: ["review-file", sessionId],
    });
  }, [active, refetchChanges, queryClient, sessionId]);

  const chooseLayout = (next: DiffLayout): void => {
    setLayout(next);
    localStorage.setItem(LOCAL_STORAGE_KEYS.REVIEW_DIFF_LAYOUT, next);
  };

  const refresh = (): void => {
    void changes.refetch();
    void queryClient.invalidateQueries({
      queryKey: ["review-file", sessionId],
    });
  };

  const selectedChange = changedPaths.find((change) => change.path === path);
  const header =
    data?.kind === "changes"
      ? t("review.summary", { count: changedPaths.length })
      : "";

  /** 左侧内容：提示、拒绝原因，或选中文件的改动。 */
  const leftPane = (): React.ReactNode => {
    if (changes.isPending) {
      return <Hint>…</Hint>;
    }
    if (changes.isError) {
      return <Hint tone="destructive">{getErrorMessage(changes.error)}</Hint>;
    }
    if (unsupported !== null) {
      return <Hint>{t(`review.unsupported.${unsupported}`)}</Hint>;
    }
    if (changedPaths.length === 0) {
      return <Hint>{t("review.empty")}</Hint>;
    }
    if (path === null) {
      return <Hint>{t("review.pickFile")}</Hint>;
    }
    if (diff.isPending) {
      return <Hint>…</Hint>;
    }
    if (diff.isError) {
      return <Hint tone="destructive">{getErrorMessage(diff.error)}</Hint>;
    }

    const result = diff.data;

    if (result.kind === "unsupported") {
      return <Hint>{t(`review.unsupported.${result.reason}`)}</Hint>;
    }
    if (result.kind === "refused") {
      return <Hint>{t(`review.refused.${result.reason}`)}</Hint>;
    }

    return <ReviewDiff item={item} key={result.path} layout={layout} />;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b pl-2 pr-4">
        {path !== null && selectedChange?.oldPath !== undefined ? (
          <InputCopyButton
            label={t("review.copyNewPath")}
            text={t("review.rename", {
              from: selectedChange.oldPath,
              to: path,
            })}
            truncate="start"
            value={path}
          />
        ) : path !== null ? (
          <InputCopyButton label={t("review.copyPath")} value={path} />
        ) : (
          <HoverScrollText
            className="flex-1 text-muted-foreground text-sm"
            value={header}
          />
        )}
        <div className="flex items-center gap-2">
          {counts === null ? null : (
            <span className="shrink-0 font-mono text-xs tabular-nums">
              <span className="text-success">+{counts.added}</span>{" "}
              <span className="text-destructive">−{counts.deleted}</span>
            </span>
          )}
          <Button
            aria-label={t("review.refresh")}
            className="shrink-0"
            onClick={refresh}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCwIcon className="size-4" />
          </Button>
          <Button
            aria-label={showTree ? t("review.hideTree") : t("review.showTree")}
            aria-pressed={showTree}
            className="shrink-0"
            onClick={() => setShowTree((visible) => !visible)}
            size="icon-sm"
            variant="ghost"
          >
            <FolderTreeIcon className="size-4" />
          </Button>
        </div>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                aria-label={t("review.settings.open")}
                className="shrink-0"
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <Settings2Icon className="size-4" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <div className="flex flex-col gap-2">
              <p className="font-medium text-muted-foreground text-xs">
                {t("review.settings.layout")}
              </p>
              <SegmentedControl className="w-full" size="sm">
                {LAYOUTS.map((option) => (
                  <SegmentedControlItem
                    aria-pressed={layout === option.value}
                    className="flex-1"
                    // 空串表示「有这个属性」，未选中时整个属性不出现：样式按属性
                    // 是否存在来判断，写成 false 会留下 data-checked="false"。
                    data-checked={layout === option.value ? "" : undefined}
                    key={option.value}
                    onClick={() => chooseLayout(option.value)}
                  >
                    {t(option.label)}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <SplitLayout
        left={leftPane()}
        showTree={showTree}
        tree={
          <>
            {data?.kind === "changes" ? (
              <p className="truncate px-3 pt-1 pb-1 text-muted-foreground text-xs">
                {data.rootName}
              </p>
            ) : null}
            <div className="min-h-0 flex-1 py-1">
              <FileTree model={model} style={treeStyle(isDark)} />
            </div>
          </>
        }
        treeRef={treeRef}
      />
    </div>
  );
}

/** 左侧的代码视图：条目已经由上面算好，这里只负责画。 */
function ReviewDiff({
  item,
  layout,
}: {
  readonly item: CodeViewItem<undefined> | null;
  readonly layout: DiffLayout;
}) {
  const { t } = useTranslation();
  const isDark = useTheme().resolvedTheme === "dark";
  const items = React.useMemo(() => (item === null ? [] : [item]), [item]);
  const options = React.useMemo(
    () => codeViewOptions(isDark, layout),
    [isDark, layout]
  );

  if (item === null) {
    return <Hint>{t("review.noContent")}</Hint>;
  }

  return (
    <CodeView
      className="h-full"
      items={items}
      options={options}
      style={CODE_VIEW_STYLE}
    />
  );
}
