/**
 * 「这个路径在不在沙箱的根目录里」的共用判断。
 *
 * 两类适配器都要同一套语义：原生隔离判断能不能写，容器判断能不能碰。判错一次的
 * 后果都是越界，所以只实现一份。
 */
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * 判断一个绝对路径是否落在某个根之下。
 *
 * 逐段比较而不是看前缀字符串：`/work/alpha-sibling` 不该被 `/work/alpha` 放行。
 */
export function isInsideRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    if (path === root) {
      return true;
    }
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return path.startsWith(prefix);
  });
}

/**
 * 目标路径的真实位置。
 *
 * 跟随最终链接时连目标一起解析：工作区里放一个指向外面的链接，不能让它把读写
 * 带到外面。删除只看目录项本身——删链接不会碰到链接的目标，链接指向外面也必须
 * 能删。
 */
export async function resolveTargetPath(
  absolute: string,
  followFinalLink: boolean
): Promise<string> {
  if (followFinalLink) {
    try {
      return await realpath(absolute);
    } catch {
      // 目标还不存在，走父目录那条路。
    }
  }

  const parent = await realpath(dirname(absolute)).catch(() =>
    dirname(absolute)
  );
  return join(parent, basename(absolute));
}
