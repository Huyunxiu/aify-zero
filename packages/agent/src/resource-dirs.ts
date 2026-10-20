import { homedir } from "node:os";
import { join } from "node:path";

/*
 * 资源目录的路径拼接工具。
 *
 * 每个资源体系各自声明自己的目录列表（`SKILL_DIRS`、
 * `GLOBAL_CONTEXT_DIR_NAMES`），这里只负责把目录名展开成 global / project
 * 两级的绝对路径，不预设顺序，也不合并两边的配置。
 */
export interface ResourceRoot {
  /** 目录名，例如 `.agents`。 */
  dir: string;
  /** 拼接后的绝对路径。 */
  root: string;
}

/** 用户级资源目录：`<home>/<dir>`，顺序与传入的 `dirs` 一致。 */
export function getGlobalResourceRoots(
  dirs: readonly string[],
  home: string = homedir()
): ResourceRoot[] {
  return dirs.map((dir) => ({ dir, root: join(home, dir) }));
}

/** 项目级资源目录：`<projectDir>/<dir>`，顺序与传入的 `dirs` 一致。 */
export function getProjectResourceRoots(
  projectDir: string,
  dirs: readonly string[]
): ResourceRoot[] {
  return dirs.map((dir) => ({ dir, root: join(projectDir, dir) }));
}
