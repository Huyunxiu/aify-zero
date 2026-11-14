import type { StructuredLoggerEnv } from "@hono/structured-logger";
import type { Language } from "@workspace/shared/constants";
import type { Logger } from "@workspace/shared/logger";

import type { AuthIdentity } from "./auth";

/**
 * Hono 的上下文变量。
 *
 * `language` 是 detector 唯一会写入的值；`auth` 由 `authenticate` 中间件
 * 写入，只有经过鉴权的路由才读得到。
 */
export type HonoEnv = StructuredLoggerEnv<Logger> & {
  Variables: { auth: AuthIdentity; language: Language };
};
