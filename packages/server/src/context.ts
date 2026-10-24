// oxlint-disable
import type { Language } from "@workspace/shared/constants";
import type { Logger } from "@workspace/shared/logger";

// 环境变量由进程入口负责加载（`apps/server` 或 Electron 传入的子进程
// env）：库模块不再按 cwd 找 `.env`，否则同一个包在不同启动目录下会连到
// 不同的数据库。

export type CreateContextOptions = {
  requestId: string;
  logger: Logger;
  /**
   * The language this request asked for, as detected by the Hono middleware in
   * `app.ts`. Always one of `SUPPORTED_LANGUAGES`, so a handler can switch on it
   * without checking it first.
   */
  language: Language;
  /**
   * The request's own signal: it aborts when the client hangs up, so a handler
   * that keeps working after it has answered — the agent turn in
   * `session.create` outlives the response it is streaming into — has
   * something to stop it.
   */
  signal: AbortSignal;
};

export async function createContext({
  requestId,
  logger,
  language,
  signal,
}: CreateContextOptions) {
  return {
    requestId,
    logger,
    language,
    signal,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
