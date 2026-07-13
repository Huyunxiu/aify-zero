import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { aiModel } from "./ai-model/ai-model.router";
import { session } from "./session";
import { setting } from "./settings/settings.router";

export const appRouter = {
  session,
  aiModel,
  setting,
  healthCheck: publicProcedure.handler(() => "OK"),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
