import type { RouterClient } from "@orpc/server";

import { t } from "../i18n";
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
  // Answers with the name of the language it was asked in — a round trip that
  // says which language the server just read off the request.
  lang: publicProcedure.handler((c) => ({
    message: t(c.context.language, "lang.displayName"),
  })),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
