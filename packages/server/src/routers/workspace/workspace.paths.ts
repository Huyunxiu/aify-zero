/**
 * 工作区文件的路径闸门。
 *
 * 所有对外接口都从这里进入：把请求路径归一化，`lstat` 请求本身，解析符号
 * 链接，再按真实路径判断是否落在允许的根里。只比较字符串前缀会被链接绕过，
 * 所以比较的两边都是 `realpath` 的结果。
 */
import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ApiError } from "../../errors";

/** 一次请求可访问的根：主目录在前，其余根只能按绝对路径命中。 */
export interface WorkspaceRoots {
  /** 相对路径的基准目录。 */
  readonly primaryDir: string;
  /** 允许访问的根；`primaryDir` 一定在内。 */
  readonly roots: readonly string[];
}

/** 闸门之后的路径：请求怎么写的、真实落在哪、以及那一刻的元数据。 */
export interface ResolvedTarget {
  /** 归一化后的请求路径，保留符号链接。 */
  readonly absolute: string;
  /** 解析符号链接后的真实路径；读写都用它。 */
  readonly realPath: string;
  /** `lstat` 的结果，用来判断请求本身是不是链接。 */
  readonly info: Stats;
  /** 请求路径本身是符号链接。 */
  readonly isSymlink: boolean;
}

/** Node 的文件错误只认 `code`，不认类名。 */
function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** 把请求路径归一化：相对路径以主目录为基准。 */
export function normalizeInputPath(
  workspace: WorkspaceRoots,
  inputPath: string
): string {
  return isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(workspace.primaryDir, inputPath);
}

/** 解析一个根的真实路径；根可能还没建出来（会话目录），失败时退回归一化路径。 */
async function realRootOf(root: string): Promise<string> {
  return await realpath(root).catch(() => resolve(root));
}

/** 真实路径是否落在某一个根里；`..` 开头的相对路径就是逃逸。 */
function contains(realRoot: string, target: string): boolean {
  const rel = relative(realRoot, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 解析请求路径并检查越界。
 *
 * 先 `lstat` 请求本身，再解析链接，最后按真实路径比较。请求的路径本身可以
 * 不存在，但目标必须存在；悬空链接按不存在处理。
 */
export async function resolveTarget(
  workspace: WorkspaceRoots,
  inputPath: string
): Promise<ResolvedTarget> {
  const absolute = normalizeInputPath(workspace, inputPath);
  const info = await lstat(absolute).catch((error: unknown) => {
    if (isErrorCode(error, "ENOENT")) {
      throw new ApiError("WORKSPACE_NOT_FOUND", { data: { path: inputPath } });
    }
    throw error;
  });
  const realPath = await realpath(absolute).catch((error: unknown) => {
    if (isErrorCode(error, "ENOENT")) {
      throw new ApiError("WORKSPACE_NOT_FOUND", { data: { path: inputPath } });
    }
    throw error;
  });

  const realRoots = await Promise.all(workspace.roots.map(realRootOf));
  if (!realRoots.some((root) => contains(root, realPath))) {
    throw new ApiError("WORKSPACE_OUTSIDE", { data: { path: inputPath } });
  }

  return { absolute, realPath, info, isSymlink: info.isSymbolicLink() };
}

/** 闸门之后的普通文件：元数据取自链接目标，不是链接自身。 */
export interface ResolvedFile extends ResolvedTarget {
  /** 目标文件的元数据；`info` 仍是请求路径本身的 `lstat` 结果。 */
  readonly fileInfo: Stats;
}

/**
 * 解析一个普通文件。
 *
 * 末尾可以是普通文件，也可以是指向普通文件的链接。链接的目标必须已经在允许
 * 的根里（`resolveTarget` 已按真实路径检查），所以指回根内的链接可以读，
 * 指到根外的链接仍按越界拒绝。
 *
 * 仓库里的文件常常是链接（`CLAUDE.md` 指向 `AGENTS.md` 就是常见写法），
 * 读取内容时应该看到目标文件，而不是因为请求路径是链接就拒绝。
 *
 * `fileInfo` 取自链接目标；读取大小和版本都以它为准，因为链接自身的大小是
 * 链接文本的长度，目标内容变化时不会变。
 */
export async function resolveRegularFile(
  workspace: WorkspaceRoots,
  inputPath: string
): Promise<ResolvedFile> {
  const target = await resolveTarget(workspace, inputPath);
  const fileInfo = target.isSymlink ? await stat(target.realPath) : target.info;
  if (!fileInfo.isFile()) {
    throw new ApiError("WORKSPACE_NOT_REGULAR_FILE", {
      data: { path: inputPath, kind: fileKindOf(fileInfo) },
    });
  }
  return { ...target, fileInfo };
}

/** `not-regular-file` 的载荷：被拒绝时目标实际是什么。 */
export function fileKindOf(info: Stats): "directory" | "other" {
  return info.isDirectory() ? "directory" : "other";
}

/** `not-directory` 的载荷：被拒绝时它是什么。 */
export function directoryKindOf(
  target: ResolvedTarget
): "file" | "symlink" | "other" {
  if (target.isSymlink) {
    return "symlink";
  }
  return target.info.isFile() ? "file" : "other";
}

/**
 * 一个目标的版本号：mtime 与大小。
 *
 * 只用于比较，不解析。文件被改写时 mtime 变化，被截断或追加时大小变化，
 * 两者合起来足够判断「内容是否还是同一份」。
 */
export function versionOf(info: Stats): string {
  return `${Math.floor(info.mtimeMs)}:${info.size}`;
}

/** 绝对路径相对主目录的写法；根是空串，分隔符统一为 `/`。 */
export async function workspacePathOf(
  workspace: WorkspaceRoots,
  realPath: string
): Promise<string> {
  const root = await realRootOf(workspace.primaryDir);
  return relative(root, realPath).split(sep).join("/");
}
