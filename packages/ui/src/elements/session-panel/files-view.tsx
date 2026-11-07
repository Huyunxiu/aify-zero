/**
 * 会话面板里的文件视图。
 *
 * 布局照编辑器来：左边是打开的文件，右边是工作区的树。树用 `@pierre/trees`
 * 的 React 入口。它按「一条路径一份数据」工作，所以每列一层目录就把新拿到
 * 的子项 `batch` 进去，不重建模型：展开状态、选中和滚动都留在模型里。
 *
 * 目录是懒加载的：展开或选中一个目录时才请求它的直接子项。左边是正文，
 * 右边是树；没有打开文件时正文留空，区域不收起，布局就不会跳。
 */
import { File as DiffFile } from "@pierre/diffs/react";
import type { FileContents, FileOptions } from "@pierre/diffs/react";
import {
  FileTree,
  useFileTree,
  useFileTreeSelection,
} from "@pierre/trees/react";
import { useQuery } from "@tanstack/react-query";
import { getErrorMessage } from "@workspace/shared/errors";
import { Button } from "@workspace/ui/components/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@workspace/ui/components/resizable";
import { client } from "@workspace/ui/lib/orpc";
import { FolderTreeIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { usePanelRef } from "react-resizable-panels";

import type { FileOpenTarget } from "../markdown-link";
import { ancestorDirectories, treePathOf } from "./reveal-path";

export type FilesViewProps = {
  /** 当前打开的文件，路径相对工作区根。 */
  readonly activeFile: string | null;
  readonly onActiveFileChange: (path: string | null) => void;
  readonly onRootNameChange: (name: string) => void;
  /** 来自聊天文件链接的定位请求；只负责在树里展开并选中。 */
  readonly reveal?: FileOpenTarget | undefined;
  /** 工作区根的目录名；没有打开文件时标签显示它。 */
  readonly rootName: string | null;
  readonly sessionId: string;
};

/** 图片交给浏览器渲染，其余按文本读。 */
const IMAGE_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

/** 根目录用空串表示；其余目录统一以 `/` 结尾，与树里的目录 id 一致。 */
function directoryKey(path: string): string {
  if (path === "" || path.endsWith("/")) {
    return path;
  }
  return `${path}/`;
}

/** 服务端的 `path` 参数：根用 `.`，目录去掉结尾的斜杠。 */
function apiPathOf(directory: string): string {
  return directory === "" ? "." : directory.replace(/\/+$/, "");
}

/** 一个子项在树里的路径；目录带结尾斜杠。 */
function childPath(
  directory: string,
  name: string,
  isDirectory: boolean
): string {
  return `${directory}${name}${isDirectory ? "/" : ""}`;
}

/** 文件字节的地址；版本参数交给服务端跳转，浏览器会缓存跳转后的地址。 */
function fileUrl(sessionId: string, path: string): string {
  const url = new URL("api/workspace/file", document.baseURI);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("path", path);
  return url.href;
}

/** 从路径里取文件名；高亮只关心它。 */
function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * 树的配色映射到应用的设计令牌。
 *
 * 树自带一份 `color-scheme: light dark`，只认系统偏好；把这些变量接上
 * `--background` / `--foreground` 之后，深浅色就跟着 `html` 上的 class 走。
 */
const TREE_THEME = {
  "--trees-bg-override": "var(--background)",
  "--trees-bg-muted-override": "var(--muted)",
  "--trees-border-color-override": "var(--border)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-scrollbar-thumb-override": "var(--border)",
  "--trees-search-bg-override": "var(--muted)",
  "--trees-search-fg-override": "var(--foreground)",
  "--trees-selected-bg-override": "var(--accent)",
  "--trees-selected-fg-override": "var(--accent-foreground)",
  "--trees-padding-inline": "4px",
} as React.CSSProperties;

/** 观察 `html` 上的深浅色 class，让树的 `color-scheme` 跟着切。 */
function useIsDark(): boolean {
  const [isDark, setIsDark] = React.useState(() =>
    document.documentElement.classList.contains("dark")
  );

  React.useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains("dark"));
    });
    observer.observe(root, { attributeFilter: ["class"], attributes: true });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

/**
 * 一个会话的工作区文件。
 *
 * @param props.sessionId - 决定可访问的根；换会话时由调用方重新挂载。
 */
export function FilesView({
  activeFile,
  onActiveFileChange,
  onRootNameChange,
  reveal,
  rootName,
  sessionId,
}: FilesViewProps) {
  const { t } = useTranslation();
  const isDark = useIsDark();
  const { model } = useFileTree({
    paths: [],
    density: "default",
    icons: "complete",
    initialExpansion: "closed",
  });
  const selected = useFileTreeSelection(model);

  const [entryCount, setEntryCount] = React.useState<number | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // 目录默认显示；收起只折叠右侧那栏，不卸载，树的状态都留着。
  const [showTree, setShowTree] = React.useState(true);
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

  // 已列出和正在列出的目录：同一目录只请求一次，展开和选中不会叠加请求。
  const loaded = React.useRef(new Set<string>());
  // 同一目录只发一次请求，并且让后来的调用等到同一个结果；否则「逐层展开」
  // 可能抢在根目录列完之前跑，树里还没有父目录，定位就落空。
  const pending = React.useRef(new Map<string, Promise<void>>());

  const loadDirectory = React.useCallback(
    async (input: string): Promise<void> => {
      const directory = directoryKey(input);

      if (loaded.current.has(directory)) {
        return;
      }

      const inFlight = pending.current.get(directory);

      if (inFlight !== undefined) {
        await inFlight;
        return;
      }

      const load = (async (): Promise<void> => {
        try {
          const listing = await client.workspace.list({
            sessionId,
            path: apiPathOf(directory),
          });
          const paths = listing.entries.map((entry) =>
            childPath(directory, entry.name, entry.type === "directory")
          );
          if (paths.length > 0) {
            model.batch(paths.map((path) => ({ path, type: "add" as const })));
            // 目录要有子项，树才认为它可以展开；这正是用户刚点开的那个目录。
            const item = model.getItem(directory);
            if (item !== null && "expand" in item) {
              item.expand();
            }
          }
          loaded.current.add(directory);
          setLoadError(null);
          if (directory === "") {
            setEntryCount(listing.entries.length);
            onRootNameChange(listing.rootName);
          }
        } catch (error) {
          setLoadError(getErrorMessage(error) ?? null);
        }
      })();

      pending.current.set(directory, load);

      try {
        await load;
      } finally {
        pending.current.delete(directory);
      }
    },
    [model, onRootNameChange, sessionId]
  );

  // 首屏只列根；更深的内容等展开。
  React.useEffect(() => {
    void loadDirectory("");
  }, [loadDirectory]);

  // 聊天里的文件链接：逐层列出父目录、展开，再选中文件。树只认根相对路径，
  // 绝对路径和带 `..` 的路径只交给预览，不在这里猜。
  React.useEffect(() => {
    if (reveal === undefined) {
      return;
    }

    const treePath = treePathOf(reveal.path);

    if (treePath === null) {
      return;
    }

    let cancelled = false;

    const open = async (): Promise<void> => {
      // 根目录先列：没有它，第一层父目录还不存在。
      for (const directory of ["", ...ancestorDirectories(treePath)]) {
        await loadDirectory(directory);

        if (cancelled) {
          return;
        }

        if (directory === "") {
          continue;
        }

        const item = model.getItem(directory);

        // 目录要先有子项，树才认为它可以展开。
        if (item !== null && "expand" in item) {
          item.expand();
        }
      }

      if (cancelled) {
        return;
      }

      const item = model.getItem(treePath);

      if (item === null) {
        return;
      }

      item.select();
      model.focusPath(treePath);
      model.scrollToPath(treePath, { offset: "nearest" });
    };

    void open();

    return () => {
      cancelled = true;
    };
  }, [reveal, loadDirectory, model]);

  // 展开一个目录时补它的直接子项：此时树里还没有这些路径。
  React.useEffect(
    () =>
      model.subscribe(() => {
        const count = model.getVisibleCount();
        if (count === 0) {
          return;
        }
        for (const row of model.getVisibleRows(0, count - 1)) {
          if (row.kind === "directory" && row.isExpanded) {
            void loadDirectory(row.path);
          }
        }
      }),
    [model, loadDirectory]
  );

  // 选中的是目录就先补内容；是文件就打开预览。
  const [current] = selected;
  React.useEffect(() => {
    if (current === undefined) {
      return;
    }
    if (current.endsWith("/")) {
      void loadDirectory(current);
      return;
    }
    onActiveFileChange(current);
  }, [current, loadDirectory, onActiveFileChange]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
          {activeFile ?? rootName ?? ""}
        </span>
        <Button
          aria-label={showTree ? t("files.hideTree") : t("files.showTree")}
          aria-pressed={showTree}
          className="shrink-0"
          onClick={() => setShowTree((visible) => !visible)}
          size="icon-sm"
          variant="ghost"
        >
          <FolderTreeIcon className="size-4" />
        </Button>
      </div>
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize={320} minSize={160}>
          <div className="flex h-full min-w-0 flex-col">
            {/* 正文再长也不参与高度：`contain: size` 让这一格的尺寸只由 flex
              决定，长文件才不会把面板和它外面整条高度链一起撑高。 */}
            <div className="min-h-0 flex-1 overflow-auto contain-[size]">
              {/* 没有选文件时区域也留着，打开文件时布局才不会跳。 */}
              {activeFile === null ? null : (
                <FilePreview
                  key={activeFile}
                  line={reveal?.path === activeFile ? reveal.line : undefined}
                  path={activeFile}
                  sessionId={sessionId}
                />
              )}
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
            {loadError === null ? null : (
              <p className="px-3 pb-2 text-destructive text-xs">{loadError}</p>
            )}
            {entryCount === 0 ? (
              <p className="px-3 text-muted-foreground text-xs">
                {t("files.empty")}
              </p>
            ) : null}
            <div className="min-h-0 flex-1 py-1">
              <FileTree
                model={model}
                style={{
                  ...TREE_THEME,
                  colorScheme: isDark ? "dark" : "light",
                  height: "100%",
                }}
              />
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

type FilePreviewProps = {
  readonly sessionId: string;
  readonly path: string;
  /** 链接里写的行号；读够这一行并高亮它。 */
  readonly line?: number | undefined;
};

/** 一页文本的上限；带行号时按行号往上加，但不超过服务端的单页上限。 */
const PREVIEW_LIMIT = 400;
const MAX_PREVIEW_LIMIT = 5000;

/** 文件预览：图片直接给地址，文本取第一页。 */
function FilePreview({ sessionId, path, line }: FilePreviewProps) {
  const { t } = useTranslation();
  const isDark = useIsDark();
  const [imageFailed, setImageFailed] = React.useState(false);
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(extension);
  // 行号只影响到读取窗口，不改变行号本身：仍然从第 1 行读起，编号才和文件一致。
  const limit =
    line === undefined
      ? PREVIEW_LIMIT
      : Math.min(MAX_PREVIEW_LIMIT, Math.max(PREVIEW_LIMIT, line + 50));
  const read = useQuery({
    queryKey: ["workspace-file", sessionId, path, limit],
    queryFn: () => client.workspace.read({ sessionId, path, offset: 1, limit }),
    enabled: !isImage,
    retry: false,
  });

  // 高亮只关心文件名和文本；两者不变时不要重建输入，省掉一次重新解析。
  const name = fileNameOf(path);
  const contents = read.data?.kind === "text" ? read.data.text : "";
  const file = React.useMemo<FileContents>(
    () => ({ name, contents }),
    [name, contents]
  );
  const options = React.useMemo<FileOptions<undefined, undefined>>(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: isDark ? "dark" : "light",
      overflow: "wrap",
      // 上方已经画出路径，这里不再重复一条文件头。
      disableFileHeader: true,
      // 文件区跟面板同底色：主题的底色只服务高亮，不要盖住工作区的背景。
      // 主题把底色收在一个变量里，改写它，宿主和行背景一起变透明。
      unsafeCSS: ":host { --diffs-bg: transparent; }",
    }),
    [isDark]
  );

  if (isImage) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        {imageFailed ? (
          <p className="text-muted-foreground text-sm">
            {t("files.unavailable")}
          </p>
        ) : (
          <img
            alt={path}
            className="max-h-full max-w-full object-contain"
            onError={() => setImageFailed(true)}
            src={fileUrl(sessionId, path)}
          />
        )}
      </div>
    );
  }

  if (read.isPending) {
    return <p className="p-4 text-muted-foreground text-sm">…</p>;
  }

  if (read.isError) {
    return (
      <p className="p-4 text-destructive text-sm">
        {getErrorMessage(read.error)}
      </p>
    );
  }

  // 不是失败：文件在，只是不能按文本预览。原因画在正中间就够了。
  if (read.data.kind === "refused") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-center text-muted-foreground text-sm">
          {t(`files.refused.${read.data.reason}`)}
        </p>
      </div>
    );
  }

  // 只高亮读到的范围：行号超过这一页时，画了也没有内容对应。
  const highlight =
    line === undefined || line > limit ? undefined : { end: line, start: line };

  return <DiffFile file={file} options={options} selectedLines={highlight} />;
}
