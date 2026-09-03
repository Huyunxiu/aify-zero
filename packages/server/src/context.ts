// oxlint-disable
import type { Logger } from "@workspace/shared/logger";
import dotenv from "dotenv";

dotenv.config({
  path: "../../packages/server/.env",
});

export type CreateContextOptions = {
  requestId: string;
  logger: Logger;
};

export async function createContext({
  requestId,
  logger,
}: CreateContextOptions) {
  return {
    requestId,
    logger,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
