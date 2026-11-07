/**
 * Markdown 链接的渲染：本地文件交给当前会话打开，其余链接保持浏览器行为。
 *
 * 回调通过上下文下发，作用域就是包住会话的那一棵树；子会话分栏各有一份，
 * 所以同一个文件链接在哪个会话里点击，就在哪个会话的面板里打开。
 */
import { cn } from "@workspace/ui/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import * as React from "react";

import { classifyMarkdownHref } from "./file-link";
import type { FileOpenTarget } from "./file-link";

export type { FileOpenTarget } from "./file-link";

/** 打开一个本地文件；目标自带路径和可选行号。 */
export type FileOpener = (target: FileOpenTarget) => void;

const FileLinkContext = React.createContext<FileOpener | undefined>(undefined);

export type FileLinkProviderProps = {
  /** 当前会话的打开动作；变化时正在显示的链接立即跟着换。 */
  readonly openFile: FileOpener;
  /** 子树；缺省时什么都不渲染。 */
  readonly children?: ReactNode;
};

/** 把「打开文件」的能力限定在会话的渲染子树里。 */
export function FileLinkProvider({
  openFile,
  children,
}: FileLinkProviderProps) {
  return (
    <FileLinkContext.Provider value={openFile}>
      {children}
    </FileLinkContext.Provider>
  );
}

/** 读取最近的打开动作；没有 Provider 时返回 undefined。 */
export function useFileLink(): FileOpener | undefined {
  return React.useContext(FileLinkContext);
}

type MarkdownLinkProps = ComponentProps<"a"> & {
  readonly node?: unknown;
};

/** 文件链接的正文样式；和正文链接保持一致。 */
const FILE_LINK_CLASS =
  "cursor-pointer underline underline-offset-2 break-words";

/**
 * 把不可达的分支变成编译错误。
 *
 * 分类结果新增 kind 时，`switch` 会漏掉一种，这里的参数类型先报错。
 */
function assertNever(value: never): never {
  throw new Error(`unhandled markdown target: ${String(value)}`);
}

/**
 * `a` 标签的替身。
 *
 * 文件链接渲染成按钮：浏览器不该为它做导航，中键也不该开出无效的新标签页。
 * 没有 Provider 时退化成普通链接，链接至少还能看。
 */
export function MarkdownLink({
  href,
  children,
  className,
  node: _node,
  ...props
}: MarkdownLinkProps) {
  const openFile = useFileLink();

  if (href === undefined || href === "") {
    return <span className={className}>{children}</span>;
  }

  const target = classifyMarkdownHref(href);

  // 不安全或无法解码的目标不渲染成链接，只留下文字。
  if (target.kind === "blocked") {
    return <span className={className}>{children}</span>;
  }

  switch (target.kind) {
    case "file": {
      if (openFile === undefined) {
        return (
          <a className={className} href={href} {...props}>
            {children}
          </a>
        );
      }

      return (
        <FileLinkButton
          className={className}
          openFile={openFile}
          target={target}
        >
          {children}
        </FileLinkButton>
      );
    }
    case "external": {
      return (
        <a
          className={className}
          href={target.href}
          {...props}
          rel="noopener noreferrer"
          target="_blank"
        >
          {children}
        </a>
      );
    }
    case "plain": {
      return (
        <a className={className} href={target.href} {...props}>
          {children}
        </a>
      );
    }
    default: {
      return assertNever(target);
    }
  }
}

type FileLinkButtonProps = {
  readonly children: ReactNode;
  readonly className: string | undefined;
  readonly openFile: FileOpener;
  readonly target: FileOpenTarget;
};

/** 文件链接的按钮本体；路径同时是悬停提示和坐标。 */
function FileLinkButton({
  children,
  className,
  openFile,
  target,
}: FileLinkButtonProps) {
  return (
    <button
      className={cn(FILE_LINK_CLASS, className)}
      data-file-link=""
      onClick={() => {
        openFile(target);
      }}
      title={target.path}
      type="button"
    >
      {children}
    </button>
  );
}
