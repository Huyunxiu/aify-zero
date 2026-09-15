// oxlint-disable
import type { Language } from "@workspace/shared/constants";
import type { Logger } from "@workspace/shared/logger";
import dotenv from "dotenv";

dotenv.config({
  path: "../../packages/server/.env",
});

export type CreateContextOptions = {
  requestId: string;
  logger: Logger;
  /**
   * The language this request asked for, as detected by the Hono middleware in
   * `app.ts`. Always one of `SUPPORTED_LANGUAGES`, so a handler can switch on it
   * without checking it first.
   */
  language: Language;
};

export async function createContext({
  requestId,
  logger,
  language,
}: CreateContextOptions) {
  return {
    requestId,
    logger,
    language,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
