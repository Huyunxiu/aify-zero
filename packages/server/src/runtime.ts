import { createAgentRunner, createTimerScheduler } from "@workspace/agent";

import { createJobNoticeAdapter } from "./job-notices";
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
    steering,
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
      steering,
    });
  },
});

// 任务结算后，完成通知投进拥有者的收件箱；空闲会话会被唤醒。
JOB_REGISTRY.setNoticeAdapter(
  createJobNoticeAdapter({ registry: JOB_REGISTRY, runner: agentRunner, store })
);

/**
 * 进程里唯一的那一个扫描循环；`serve.ts` 启动和关停它。
 *
 * 它只把到点的定时器换成收件箱里的待办项，起跑仍然是运行器的事。所以唤醒
 * 走的是运行器的公开入口，而不是另开一条起跑路径（ADR 0012）。
 */
export const timerScheduler = createTimerScheduler({
  store,
  wake: (sessionId) => {
    agentRunner.wake(sessionId);
  },
});
