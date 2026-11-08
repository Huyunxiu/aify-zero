/**
 * 改动视图的两个纯映射：右侧树要什么，左侧代码视图要什么。
 *
 * 右边只列有改动的路径，父目录由 `@pierre/trees` 按路径隐含出来；每个路径上的
 * 状态用树自带的 git 状态表达，目录上的汇总也由它自己算。
 *
 * 左边把一个改动的两侧文本解析成差异条目；未变的区域因此可以展开，这是选
 * `@pierre/diffs` 的主要理由。两侧文本相同时旧侧当作不存在：整份内容按新增
 * 画成绿色，空差异只剩一片空白，读不出任何东西。
 *
 * 这一层是纯函数：给服务端的数据，给两个第三方组件要的形状；不碰 React，
 * 也不碰请求，所以能直接单测。
 */
import type {
  CodeViewItem,
  FileContents,
  FileDiffMetadata,
} from "@pierre/diffs";
import { parseDiffFromFile } from "@pierre/diffs";
import type { GitStatusEntry } from "@pierre/trees";

import { fileNameOf } from "../../lib/workspace-path";

// ── 右侧树 ──────────────────────────────────────────────────────────────────

/** 一处改动在树里的样子：路径加状态。 */
export type TreeChange = GitStatusEntry;

/** 树的输入：要放进树的路径，以及每个路径上的状态。 */
export interface TreeInput {
  readonly paths: readonly string[];
  readonly gitStatus: readonly GitStatusEntry[];
}

/**
 * 把改动列表换成树的输入。
 *
 * 服务端保证一个路径只有一条改动，所以这里不做去重：树按路径认条目，重复的
 * 路径本来就不该出现。
 *
 * @param changes - 服务端给的改动列表。
 * @returns 路径列表与状态列表，顺序与输入一致。
 */
export function treeInputOf(changes: readonly TreeChange[]): TreeInput {
  return {
    paths: changes.map((change) => change.path),
    gitStatus: changes.map(({ path, status }) => ({ path, status })),
  };
}

// ── 左侧内容 ────────────────────────────────────────────────────────────────

/** 一个改动的两侧文本；某一侧不存在时是 null。 */
export interface DiffSides {
  /** 相对工作区根的路径。 */
  readonly path: string;
  /** 重命名时的旧路径。 */
  readonly oldPath?: string;
  /** 基线一侧的文本；这一侧不存在时为 null。 */
  readonly oldText: string | null;
  /** 工作区一侧的文本；这一侧不存在时为 null。 */
  readonly newText: string | null;
}

/**
 * 一个改动在代码视图里的条目。
 *
 * 两侧文本相同时（纯重命名，或文件被改回原样），旧侧当作不存在：整份内容按
 * 新增画成绿色。空差异只剩一片空白，读不出任何东西；把内容全部铺开，至少
 * 让人看见这个路径现在是什么。
 *
 * @param sides - 两侧文本与路径。
 * @param version - 内容版本号，由 `useContentVersion` 给出。
 * @returns 差异条目；两侧都没有文本时返回 null（没有可画的东西）。
 */
export function reviewItemOf(
  sides: DiffSides,
  version: number
): CodeViewItem<undefined> | null {
  const { path, oldText, newText } = sides;

  if (oldText === null && newText === null) {
    return null;
  }

  // 条目 id 就是这个改动在工作区里的路径；一个查看器里路径唯一，够用了。
  const id = path;
  const name = fileNameOf(path);
  // 内容没变：没有可比的新旧，整份都算新增。
  const unchanged = oldText !== null && oldText === newText;

  const oldFile =
    oldText === null || unchanged
      ? null
      : ({
          contents: oldText,
          name: fileNameOf(sides.oldPath ?? path),
        } satisfies FileContents);
  const newFile =
    newText === null
      ? null
      : ({ contents: newText, name } satisfies FileContents);

  return {
    fileDiff: parseDiffFromFile(oldFile, newFile),
    id,
    type: "diff",
    version,
  };
}

/** 一个差异的增删行数。 */
export interface LineCounts {
  readonly added: number;
  readonly deleted: number;
}

/**
 * 一个差异的增删行数。
 *
 * 数字取自每个 hunk 的计数，而不是 `additionLines` / `deletionLines` 的长度：
 * 后者在由完整内容解析出来时是整份文件的行，不是增删的行。
 *
 * @param fileDiff - 解析好的差异。
 * @returns 新增与删除的行数。
 */
export function lineCountsOf(fileDiff: FileDiffMetadata): LineCounts {
  let added = 0;
  let deleted = 0;

  for (const hunk of fileDiff.hunks) {
    added += hunk.additionLines;
    deleted += hunk.deletionLines;
  }

  return { added, deleted };
}
