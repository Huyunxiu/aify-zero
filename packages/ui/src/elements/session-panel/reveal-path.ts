/**
 * 文件视图的定位路径。
 *
 * 文件树只认「相对工作区根、用正斜杠、目录以 `/` 结尾」的写法。链接里可能
 * 是绝对路径、盘符或带 `..` 的路径，这些只能交给预览，不能在树里定位，
 * 所以这里把它们判成 null。
 */

/** 盘符或 UNC 开头的目标：树里没有对应节点。 */
const ABSOLUTE_PREFIX = /^(?:[a-z]:|\/|\\\\)/iu;

/**
 * 把链接路径换成树里的写法。
 *
 * @param path - 归一化后的链接路径。
 * @returns 根相对路径；绝对路径、含 `..` 或空段的路径返回 null。
 */
export function treePathOf(path: string): string | null {
  const normalized = path.replace(/^(?:\.\/)+/u, "");

  if (normalized === "" || ABSOLUTE_PREFIX.test(normalized)) {
    return null;
  }

  const segments = normalized.split("/");

  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    return null;
  }

  return normalized;
}

/**
 * 一个文件路径逐层的父目录。
 *
 * @param treePath - 树里的文件路径，例如 `a/b/c.ts`。
 * @returns 依次要展开的目录，例如 `['a/', 'a/b/']`；根下的文件返回空数组。
 */
export function ancestorDirectories(treePath: string): string[] {
  const segments = treePath.split("/");
  const directories: string[] = [];
  let prefix = "";

  for (const segment of segments.slice(0, -1)) {
    prefix = `${prefix}${segment}/`;
    directories.push(prefix);
  }

  return directories;
}
