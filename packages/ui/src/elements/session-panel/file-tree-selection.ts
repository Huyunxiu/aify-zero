/**
 * 文件树的选择操作。
 *
 * `@pierre/trees` 的条目句柄只有 `select()`、`deselect()`、`toggleSelect()`；
 * `select()` 是累加语义（往选择集合里加），库没有公开「只选这一个」。行点击
 * 走的是控制器私有方法，所以点击本身是单选；从聊天链接跳过来时得自己先清空，
 * 否则上一次选中的文件会和这一次选中的文件或目录同时高亮。
 */
import type { FileTree } from "@pierre/trees";

/**
 * 让树里只剩一个选中项，和行点击的单击语义一致。
 *
 * @param model - 树模型。
 * @param path - 要选中的路径；目录带结尾 `/`。
 */
export function selectOnlyPath(model: FileTree, path: string): void {
  for (const selected of model.getSelectedPaths()) {
    if (selected !== path) {
      model.getItem(selected)?.deselect();
    }
  }

  model.getItem(path)?.select();
}
