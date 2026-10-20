import { homedir } from "node:os";
import { join } from "node:path";

const primaryProjectDir = "/Users/huyunxiu/HuYunXiu/aify-zero";

/**
 * agent 可以读写代码的项目目录，第一项是主目录（primary）。
 *
 * 资源加载和工具的相对路径只以主目录为基准；其余目录需要绝对路径访问。
 * TODO: 以后由会话/工作区设置提供，现在固定为本仓库。
 */
export const PROJECT_DIRS: readonly string[] = [primaryProjectDir];

/** 主目录，即 `PROJECT_DIRS` 的第一项。 */
export const PRIMARY_PROJECT_DIR = primaryProjectDir;

/**
 * agent 的会话私有目录：`~/.aify-zero/sessions/<sessionId>`。
 *
 * 和数据目录共用 `~/.aify-zero`，存会话过程中的临时文件与 artifacts。
 */
export function getSessionDir(sessionId: string): string {
  return join(homedir(), ".aify-zero", "sessions", sessionId);
}
