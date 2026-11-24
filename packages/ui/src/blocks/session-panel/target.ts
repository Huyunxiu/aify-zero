/**
 * 面板当前打开的目标。
 *
 * 路径和高亮区间必须一起变。分成两份状态时，树里另选文件只改路径，旧区间还在，
 * 预览就会在另一个文件上继续画上一段高亮；这里把两者收成一份，换文件时自然
 * 只留下路径。
 */
import type { FileOpenTarget } from "../markdown-link";

/**
 * 树里选中一个文件后的目标。
 *
 * 同一个文件再次被选中时保留区间：链接跳转本身也会在树里选中一次，不能把它
 * 刚设置的区间清掉。换到别的文件时只保留路径。
 *
 * @param current - 当前目标。
 * @param path - 树里选中的路径；`null` 表示取消选中。
 * @returns 新的目标。
 */
export function targetAfterSelect(
  current: FileOpenTarget | null,
  path: string | null
): FileOpenTarget | null {
  if (path === null) {
    return null;
  }

  return current?.path === path ? current : { path };
}
