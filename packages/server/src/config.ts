import { homedir } from "node:os";
import { join } from "node:path";

/**
 * agent 的会话私有目录：`~/.aify-zero/sessions/<sessionId>`。
 *
 * 和数据目录共用 `~/.aify-zero`，存会话过程中的临时文件与 artifacts。
 */
export function getSessionDir(sessionId: string): string {
  return join(homedir(), ".aify-zero", "sessions", sessionId);
}
