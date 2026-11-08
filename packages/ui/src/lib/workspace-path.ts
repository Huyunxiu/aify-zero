/**
 * 工作区路径的两种写法。
 *
 * 链接里写的是原文：可能带反斜杠、盘符或 `..`。树里只认根相对、正斜杠、
 * 目录带结尾 `/` 的写法。两种写法的归一和校验放在这里，别处不再各写一套。
 */

/** 盘符、根斜杠或 UNC 开头：树里没有对应节点。 */
const ABSOLUTE_PREFIX = /^(?:[a-z]:|\/|\\\\)/iu;

/** 反斜杠写法：盘符、UNC，或整串都没有正斜杠。 */
const WINDOWS_SHAPED = /^(?:[a-z]:[\\/]|\\\\)/iu;

/** 是否是反斜杠写法的路径。 */
function isWindowsShaped(value: string): boolean {
  return (
    WINDOWS_SHAPED.test(value) || (value.includes("\\") && !value.includes("/"))
  );
}

/**
 * 链接路径的写法：正斜杠，去掉开头的 `./`，目录不带结尾 `/`。
 *
 * 目录也走同一条路：结尾的斜杠去掉后，面板按目录节点定位它。
 *
 * @param value - Markdown 目标里解码后的路径原文。
 * @returns 正斜杠、无开头 `./`、无结尾 `/` 的路径；根目录保留单个斜杠。
 */
export function linkPathOf(value: string): string {
  const slashed = isWindowsShaped(value) ? value.replaceAll("\\", "/") : value;
  const trimmed = slashed.replace(/^(?:\.\/)+/u, "");

  // 根目录本身保留斜杠，否则会变成空串。
  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/u, "");
}

/**
 * 树里的写法：根相对、正斜杠、没有空段。
 *
 * @param path - 已经归一过的链接路径。
 * @returns 原路径；绝对路径、含 `..`、`.` 或空段的路径返回 null。
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

/**
 * 路径里的文件名：最后一个 `/` 之后的部分。
 *
 * @param path - 工作区根相对的路径。
 * @returns 文件名；路径本身没有 `/` 时就是它自己。
 */
export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * 这个路径在树里是不是目录。
 *
 * 树用结尾的 `/` 区分目录和文件，判断只写这一处。
 *
 * @param path - 树里的路径。
 * @returns 结尾是 `/` 时为 true。
 */
export function isDirectoryPath(path: string): boolean {
  return path.endsWith("/");
}
