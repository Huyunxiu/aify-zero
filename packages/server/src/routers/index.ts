import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { aiModel } from "./ai-model/ai-model.router";
import { session } from "./session";

export const appRouter = {
  session,
  aiModel,
  healthCheck: publicProcedure.handler(() => "OK"),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
