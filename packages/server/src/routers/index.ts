import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { chat } from "./chat";

export const appRouter = {
  chat,
  healthCheck: publicProcedure.handler(() => "OK"),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
