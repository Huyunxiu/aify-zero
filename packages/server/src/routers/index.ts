import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { session } from "./session";
import { setting } from "./settings/settings.router";

export const appRouter = {
  session,
  setting,
  healthCheck: publicProcedure.handler(() => "OK"),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
