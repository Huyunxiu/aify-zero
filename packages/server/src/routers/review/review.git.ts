/**
 * 改动视图的 git 读取层。
 *
 * 只回答两件事：工作区相对基线改了哪些路径，以及某个路径在基线那一侧的字节。
 * 会话到根的解析在 `review.service.ts`；这里只认一个目录，所以测试可以直接在
 * 临时仓库上跑。
 *
 * 所有命令都以仓库根为工作目录。这样一来 `git status` 输出的路径一律相对仓库
 * 根，不必猜它相对谁；主目录落在仓库子目录里时，再用 `rev-parse --show-prefix`
 * 的前缀过滤，换算成相对主目录的写法。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ApiError } from "../../errors";

const exec = promisify(execFile);

/** git 的输出可能很大（未跟踪文件全展开时尤其）；给足上限，别让它截断。 */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

/** NUL 分隔的 porcelain v2 记录之间的分隔符。 */
const NUL = String.fromCodePoint(0);

/** 一处改动相对基线的性质；与 `@pierre/trees` 的 git 状态同名。 */
export type ReviewChangeStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "untracked";

export interface ReviewChange {
  /** 相对主目录的路径。 */
  readonly path: string;
  /** 重命名时的旧路径，同样相对主目录。 */
  readonly oldPath?: string;
  readonly status: ReviewChangeStatus;
}

export interface RepositoryLocation {
  /** 仓库根；所有 git 命令都在这里跑。 */
  readonly root: string;
  /** 主目录在仓库里的前缀：主目录就是仓库根时是空串，否则以 `/` 结尾。 */
  readonly prefix: string;
  /** 仓库已有第一个提交。空的 `HEAD` 没有基线，所有文件按新增算。 */
  readonly hasHead: boolean;
}

/** 探测仓库的结果：找到了，或为什么列不出改动。 */
export type RepositoryProbe =
  | { readonly kind: "repository"; readonly location: RepositoryLocation }
  | {
      readonly kind: "missing";
      readonly reason: "git-missing" | "not-a-repository";
    };

/**
 * 一次 git 调用的结果。
 *
 * 非零退出是常态（`rev-parse --verify` 用退出码回答「有没有」），所以它按结果
 * 返回，不抛异常；启动不了 git（没装、没权限）要单独记下来，那和「不是仓库」
 * 不是一回事。
 */
type GitRun =
  | { readonly kind: "ok"; readonly stdout: Buffer }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "missing"; readonly error: unknown };

function isSpawnFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const { code } = error as { code?: unknown };
  return code === "ENOENT" || code === "EACCES";
}

/** 跑一次 git；退出码和 stderr 都留给调用方判断。 */
async function runGit(cwd: string, args: readonly string[]): Promise<GitRun> {
  try {
    const { stdout } = await exec("git", [...args], {
      cwd,
      encoding: "buffer",
      maxBuffer: MAX_GIT_OUTPUT,
    });
    return { kind: "ok", stdout };
  } catch (error: unknown) {
    return isSpawnFailure(error)
      ? { kind: "missing", error }
      : { kind: "failed", error };
  }
}

function textOf(bytes: Buffer): string {
  return bytes.toString("utf-8");
}

/** 主目录在仓库里的前缀；git 已经写成以 `/` 结尾，这里只确认一遍。 */
function prefixOf(prefix: string): string {
  if (prefix === "" || prefix.endsWith("/")) {
    return prefix;
  }
  return `${prefix}/`;
}

/**
 * 在某个目录里找仓库。
 *
 * @param dir - 主目录；git 会向上找仓库。
 * @returns 仓库的位置，或列不出改动的原因。
 */
export async function locateRepository(dir: string): Promise<RepositoryProbe> {
  const top = await runGit(dir, ["rev-parse", "--show-toplevel"]);

  if (top.kind !== "ok") {
    return {
      kind: "missing",
      reason: top.kind === "missing" ? "git-missing" : "not-a-repository",
    };
  }

  const root = textOf(top.stdout).trim();
  // 前缀要按主目录算，所以这条也在主目录里跑，不能在仓库根跑。
  const prefixRun = await runGit(dir, ["rev-parse", "--show-prefix"]);
  const prefix =
    prefixRun.kind === "ok" ? prefixOf(textOf(prefixRun.stdout).trim()) : "";

  // `--quiet` 让空仓库用退出码回答，而不是在 stderr 上抱怨。
  const head = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);

  return {
    kind: "repository",
    location: { root, prefix, hasHead: head.kind === "ok" },
  };
}

/**
 * 按空格切出前 `count` 个固定字段，剩下的整段是路径。
 *
 * 路径本身可以含空格，甚至连续空格，所以不能用 `split(" ")` 再拼回去：
 * 那样会把这些空格压成一个。
 */
function splitFixed(
  record: string,
  count: number
): { readonly fields: readonly string[]; readonly path: string } | null {
  const fields: string[] = [];
  let rest = record;

  for (let index = 0; index < count; index += 1) {
    const space = rest.indexOf(" ");

    if (space === -1) {
      return null;
    }

    fields.push(rest.slice(0, space));
    rest = rest.slice(space + 1);
  }

  return { fields, path: rest };
}

/** 普通记录的 `XY`：暂存与工作区各一位。 */
function statusOfXY(xy: string): ReviewChangeStatus {
  const staged = xy.slice(0, 1);
  const worktree = xy.slice(1, 2);

  if (staged === "D" || worktree === "D") {
    return "deleted";
  }
  if (staged === "A") {
    return "added";
  }
  return "modified";
}

/**
 * 解析 `git status --porcelain=v2 -z` 的输出。
 *
 * 记录以 NUL 结尾，所以直接按 NUL 切开：普通记录占一条，重命名记录占两条
 * （新路径在前，旧路径在后）。路径本身可以含空格，所以固定字段按个数切，
 * 剩下的整段都是路径。
 *
 * @param output - 命令的原始输出。
 * @returns 相对仓库根的改动，顺序与 git 给的一致。被忽略的路径不列。
 */
export function parseStatus(output: string): readonly ReviewChange[] {
  const records = output.split(NUL);
  const changes: ReviewChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    if (record === undefined || record === "") {
      continue;
    }

    const kind = record.slice(0, 1);

    if (kind === "?") {
      changes.push({ path: record.slice(2), status: "untracked" });
      continue;
    }

    if (kind === "!") {
      // 被忽略的路径不是改动，界面也不该列。
      continue;
    }

    // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
    if (kind === "1") {
      const split = splitFixed(record.slice(2), 7);

      if (split !== null && split.path !== "") {
        changes.push({
          path: split.path,
          status: statusOfXY(split.fields[0] ?? ""),
        });
      }
      continue;
    }

    // `2 <XY> ... <X><score> <path>` 后面紧跟一条旧路径。
    if (kind === "2") {
      const split = splitFixed(record.slice(2), 8);
      const oldPath = records[index + 1] ?? "";

      index += 1;

      if (split === null || split.path === "") {
        continue;
      }

      // 复制记录的分数位以 `C` 开头：原文件还在，新路径对主目录来说是新增。
      const copied = (split.fields[7] ?? "").startsWith("C");

      changes.push({
        path: split.path,
        oldPath: copied ? undefined : oldPath,
        status: copied ? "added" : "renamed",
      });
      continue;
    }

    // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
    if (kind === "u") {
      const split = splitFixed(record.slice(2), 9);

      if (split !== null && split.path !== "") {
        changes.push({ path: split.path, status: "modified" });
      }
    }
  }

  return changes;
}

/**
 * 主目录的相对路径换成仓库根的写法。
 *
 * 前缀的含义由这里负责（主目录就是仓库根时是空串，否则以 `/` 结尾），
 * 所以拼法也只写在这里，调用方不必知道前缀的细节。
 *
 * @param location - 已经找到的仓库。
 * @param path - 相对主目录的路径。
 * @returns 相对仓库根的路径。
 */
export function repoPathOf(location: RepositoryLocation, path: string): string {
  return `${location.prefix}${path}`;
}

/** 仓库根的相对路径换成主目录的相对路径；不在主目录里时返回 null。 */
function relativeToPrefix(repoPath: string, prefix: string): string | null {
  if (prefix === "") {
    return repoPath;
  }
  if (!repoPath.startsWith(prefix)) {
    return null;
  }
  const rest = repoPath.slice(prefix.length);
  return rest === "" ? null : rest;
}

/**
 * 把一条仓库根的改动换算到主目录。
 *
 * 重命名的两侧可能只有一侧在主目录里：从外面移进来是新增，移到外面是删除。
 * 所以一条仓库记录可能变成一条工作区记录、两条，或者没有。
 */
function inWorkspace(
  change: ReviewChange,
  prefix: string
): readonly ReviewChange[] {
  const path = relativeToPrefix(change.path, prefix);

  if (change.oldPath === undefined) {
    return path === null ? [] : [{ ...change, path }];
  }

  const oldPath = relativeToPrefix(change.oldPath, prefix);

  if (path !== null && oldPath !== null) {
    return [{ path, oldPath, status: change.status }];
  }

  // 旧路径在主目录外：旧内容无从比较，对工作区来说这是新增。
  if (path !== null) {
    return [{ path, status: "added" }];
  }

  // 新路径在主目录外：这份内容离开了工作区，对它来说这是删除。
  if (oldPath !== null) {
    return [{ path: oldPath, status: "deleted" }];
  }

  return [];
}

/**
 * 列出仓库里的改动，换算成相对主目录的路径。
 *
 * @param location - 已经找到的仓库。
 * @throws {ApiError} `git status` 失败：仓库找到了却读不出状态，是异常，不是空列表。
 */
export async function readRepositoryChanges(
  location: RepositoryLocation
): Promise<readonly ReviewChange[]> {
  const status = await runGit(location.root, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);

  if (status.kind !== "ok") {
    throw new ApiError("INTERNAL_SERVER_ERROR", {
      cause: status.error,
      message: "git status failed",
    });
  }

  return parseStatus(textOf(status.stdout)).flatMap((change) =>
    inWorkspace(change, location.prefix)
  );
}

/** 基线一侧的读取结果：没有这一侧、太大，或内容。 */
export type BaselineRead =
  | { readonly kind: "missing" }
  | { readonly kind: "too-large" }
  | { readonly kind: "bytes"; readonly bytes: Buffer };

/**
 * 读基线一侧的字节。
 *
 * 没有第一个提交时基线是空树，没有旧内容；路径不在基线里（新增、未跟踪）也
 * 按同样方式回答——两种情况都只是「这一侧不存在」，不是失败。
 *
 * 先问大小再取内容：一个几百兆的 blob 不该为了判断「超上限」就被整份读进来。
 *
 * @param location - 已经找到的仓库。
 * @param repoPath - 相对仓库根的路径。
 * @param maxBytes - 允许读入的上限。
 * @returns 字节、没有这一侧，或太大。
 */
export async function readBaselineBytes(
  location: RepositoryLocation,
  repoPath: string,
  maxBytes: number
): Promise<BaselineRead> {
  if (!location.hasHead) {
    return { kind: "missing" };
  }

  const size = await runGit(location.root, [
    "cat-file",
    "-s",
    `HEAD:${repoPath}`,
  ]);

  if (size.kind !== "ok") {
    return { kind: "missing" };
  }

  const bytes = Number.parseInt(textOf(size.stdout).trim(), 10);

  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return { kind: "missing" };
  }
  if (bytes > maxBytes) {
    return { kind: "too-large" };
  }

  const show = await runGit(location.root, ["show", `HEAD:${repoPath}`]);

  return show.kind === "ok"
    ? { kind: "bytes", bytes: show.stdout }
    : { kind: "missing" };
}
