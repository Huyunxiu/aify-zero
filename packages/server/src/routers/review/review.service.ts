/**
 * 改动视图的读模型。
 *
 * 两个问题各自一个函数：工作区有哪些改动，以及一个改动两侧的文本。判定都基于
 * 基线（`HEAD`），已暂存和未暂存的改动不再区分——工作区最终长什么样，正是这个
 * 视图要回答的问题。
 *
 * 「目录不是仓库」「文件不是文本」「文件超出上限」都按结果返回，不抛出：它们
 * 是目录或文件的属性，不是请求失败。界面要在自己的区域里说明原因，而失败会走
 * 全局错误提示，那条提示对用户刚点开的视图没有意义。
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { ApiError } from "../../errors";
import { DEFAULT_LIMITS } from "../workspace/workspace.files";
import { resolveRegularFile } from "../workspace/workspace.paths";
import type { WorkspaceRoots } from "../workspace/workspace.paths";
import {
  locateRepository,
  readBaselineBytes,
  readRepositoryChanges,
  repoPathOf,
} from "./review.git";
import type {
  RepositoryProbe,
  ReviewChange,
  ReviewChangeStatus,
} from "./review.git";

// ── 结果 ────────────────────────────────────────────────────────────────────

/** 什么也列不出来时的原因。 */
export type ReviewUnsupportedReason = "git-missing" | "not-a-repository";

/** 不能按文本画差异的原因。 */
export type ReviewFileRefusal = "binary" | "too-large";

export type ReviewChangesResult =
  | {
      readonly kind: "changes";
      /** 仓库已有第一个提交；没有时基线是空树，所有文件都是新增。 */
      readonly hasHead: boolean;
      /** 主目录的目录名；界面把它画成改动列表的标题。 */
      readonly rootName: string;
      readonly changes: readonly ReviewChange[];
    }
  | { readonly kind: "unsupported"; readonly reason: ReviewUnsupportedReason };

export type ReviewFileResult =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly oldPath?: string;
      readonly status: ReviewChangeStatus;
      /** 基线一侧的文本；这一侧不存在时为 null。 */
      readonly oldText: string | null;
      /** 工作区一侧的文本；这一侧不存在时为 null。 */
      readonly newText: string | null;
    }
  | {
      readonly kind: "refused";
      readonly path: string;
      readonly reason: ReviewFileRefusal;
    }
  | { readonly kind: "unsupported"; readonly reason: ReviewUnsupportedReason };

// ── 路径 ────────────────────────────────────────────────────────────────────

/**
 * 校验客户端给的路径。
 *
 * 只接受主目录相对的正斜杠路径：绝对路径、盘符和 `..` 一律拒绝，免得把仓库
 * 之外的东西带进 git 的参数。真实读写仍然走工作区的路径闸门。
 */
function checkedPathOf(input: string): string {
  const absolute = input.startsWith("/") || /^[a-z]:/iu.test(input);
  const segments = input.split("/");
  const escaped = segments.some(
    (segment) => segment === "" || segment === "." || segment === ".."
  );

  if (absolute || escaped) {
    throw new ApiError("BAD_REQUEST", {
      message: "path must be relative to the workspace root",
    });
  }

  return input;
}

// ── 文本 ────────────────────────────────────────────────────────────────────

/** 出现即视为二进制。 */
const NUL_BYTE = 0;

/** 严格解码：非法 UTF-8 序列要能报出来，而不是悄悄换成替换字符。 */
const DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * 字节换成文本；不是文本时返回 null。
 *
 * @param bytes - 一侧的原始字节。
 * @returns UTF-8 文本，或 null（含 NUL 或不是合法 UTF-8）。
 */
function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(NUL_BYTE)) {
    return null;
  }
  try {
    return DECODER.decode(bytes);
  } catch {
    return null;
  }
}

/** 一侧的读取结果：没有这一侧、太大，或内容。 */
type SideRead =
  | { readonly kind: "missing" }
  | { readonly kind: "too-large" }
  | { readonly kind: "bytes"; readonly bytes: Buffer };

// ── 改动列表 ────────────────────────────────────────────────────────────────

/**
 * 列出主目录里的改动。
 *
 * @param workspace - 允许访问的根；主目录决定在哪个仓库里找改动。
 */
export async function readReviewChanges(
  workspace: WorkspaceRoots
): Promise<ReviewChangesResult> {
  const probe: RepositoryProbe = await locateRepository(workspace.primaryDir);

  if (probe.kind === "missing") {
    return { kind: "unsupported", reason: probe.reason };
  }

  const changes = await readRepositoryChanges(probe.location);
  const rootName = basename(workspace.primaryDir) || workspace.primaryDir;

  return {
    kind: "changes",
    hasHead: probe.location.hasHead,
    rootName,
    changes,
  };
}

// ── 单个文件 ────────────────────────────────────────────────────────────────

/**
 * 读一个改动两侧的文本。
 *
 * 状态取自当前的改动列表，所以重命名能拿到旧路径。列表里已经没有这个路径时
 * （用户在两次读取之间又改了文件），按「修改」处理：基线里有旧内容就比，没有
 * 就按新增。
 *
 * @param workspace - 允许访问的根。
 * @param inputPath - 主目录相对的路径。
 */
export async function readReviewFile(
  workspace: WorkspaceRoots,
  inputPath: string
): Promise<ReviewFileResult> {
  const path = checkedPathOf(inputPath);
  const probe = await locateRepository(workspace.primaryDir);

  if (probe.kind === "missing") {
    return { kind: "unsupported", reason: probe.reason };
  }

  const { location } = probe;
  const changes = await readRepositoryChanges(location);
  const change = changes.find((item) => item.path === path);

  const status = change?.status ?? "modified";
  const oldPath = change?.oldPath;

  // 基线里的路径：重命名要读旧路径，其余就是这一条路径。
  const oldSide = await readBaselineBytes(
    location,
    repoPathOf(location, oldPath ?? path),
    DEFAULT_LIMITS.maxBytes
  );
  const newSide: SideRead =
    status === "deleted"
      ? { kind: "missing" }
      : await readNewBytes(workspace, path);

  if (oldSide.kind === "too-large" || newSide.kind === "too-large") {
    return { kind: "refused", path, reason: "too-large" };
  }

  const oldText = oldSide.kind === "bytes" ? decodeText(oldSide.bytes) : null;
  const newText = newSide.kind === "bytes" ? decodeText(newSide.bytes) : null;

  // 某一侧有字节却解不出文本：这一份不是文本，差异也画不出来。
  if (
    (oldSide.kind === "bytes" && oldText === null) ||
    (newSide.kind === "bytes" && newText === null)
  ) {
    return { kind: "refused", path, reason: "binary" };
  }

  return {
    kind: "file",
    path,
    status,
    oldText,
    newText,
    ...(oldPath === undefined ? {} : { oldPath }),
  };
}

/**
 * 读工作区一侧的字节。
 *
 * 文件在两次读取之间被删掉时没有新内容可读——那不是错误，只是这一侧不存在，
 * 和删除的状态一起画成整篇删除就够了。
 */
async function readNewBytes(
  workspace: WorkspaceRoots,
  path: string
): Promise<SideRead> {
  try {
    const target = await resolveRegularFile(workspace, path);

    // 先看大小再读：超上限的文件不该为了判断「超上限」被整份读进内存。
    if (target.fileInfo.size > DEFAULT_LIMITS.maxBytes) {
      return { kind: "too-large" };
    }

    return { kind: "bytes", bytes: await readFile(target.realPath) };
  } catch (error: unknown) {
    if (error instanceof ApiError && error.code === "WORKSPACE_NOT_FOUND") {
      return { kind: "missing" };
    }
    throw error;
  }
}
