import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { thread } from "./thread";

export const appRouter = {
  thread,
  healthCheck: publicProcedure.handler(() => "OK"),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
