import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { session } from "./session";

export const appRouter = {
  session,
  healthCheck: publicProcedure.handler(() => "OK"),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
