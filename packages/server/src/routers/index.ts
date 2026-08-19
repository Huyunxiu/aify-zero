import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { agent } from "./agent/agent.router";
import { session } from "./session";
import { setting } from "./settings/settings.router";
import { skill } from "./skill/skill.router";

export const appRouter = {
  agent,
  skill,
  session,
  setting,
  healthCheck: publicProcedure.handler(() => "OK"),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
