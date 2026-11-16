import { createAgentRunner } from "@workspace/agent";

import { JOB_REGISTRY } from "./jobs";
import { findConfiguredModel } from "./routers/settings/settings.service";
import { buildSessionAgent } from "./session/agent";
import { acceptedEffort } from "./session/model-rules";
import { SQLiteStore } from "./storage/sqlite-store";

/** 进程里唯一的那一个运行器；所有路由和启动/关停都用它。 */
const store = new SQLiteStore();

export const agentRunner = createAgentRunner({
  store,
  jobs: JOB_REGISTRY,
  buildAgent: async ({
    sessionId,
    session,
    model,
    effort,
    projectId,
    streams,
    jobs,
  }) => {
    const configured = await findConfiguredModel(model);
    if (!configured) {
      throw new Error(
        `model is not configured: ${model.providerId}/${model.modelId}`
      );
    }

    return await buildSessionAgent({
      sessionId,
      session,
      configured,
      effort: acceptedEffort(configured, effort),
      projectId,
      store,
      streams,
      jobs,
    });
  },
});
