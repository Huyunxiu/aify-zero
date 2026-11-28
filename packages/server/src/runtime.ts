import { createAgentRunner, createTimerScheduler } from "@workspace/agent";

import { createJobNoticeAdapter } from "./job-notices";
import { JOB_REGISTRY } from "./jobs";
import { createOutboxDispatcher } from "./outbox/dispatcher";
import { findConfiguredModel } from "./routers/settings/settings.service";
import { buildSessionAgent } from "./session/agent";
import { acceptedEffort } from "./session/model-rules";
import { SQLiteStore } from "./storage/sqlite-store";

/** 进程里唯一的那一个运行器；所有路由和启动/关停都用它。 */
const store = new SQLiteStore();

/** 进程里唯一的那一个投递器；`serve.ts` 启动和关停它。 */
export const outboxDispatcher = createOutboxDispatcher({ store });

/**
 * The knobs the agent runtime reads from the environment.
 *
 * None of them has a settings surface: a decision to put one in the database
 * waits for the second use case, as `AIFY_SANDBOX_ADAPTER` does. ADR 0042 says
 * what the two subagent knobs mean and what their defaults are; the timer scan
 * moves only so an end-to-end case can see a due timer within a minute instead
 * of two scans.
 */
const SCAN_MS_ENV = "AIFY_TIMER_SCAN_MS";
const SUBAGENT_LIMIT_ENV = "AIFY_SUBAGENT_LIMIT";
const SUBAGENT_TIMEOUT_ENV = "AIFY_SUBAGENT_TIMEOUT_MS";

/** A positive whole number from the environment; unset or malformed means "use the default". */
const positiveEnv = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/** Read once: these do not change while the process runs. */
const subagentLimit = positiveEnv(SUBAGENT_LIMIT_ENV);
const subagentTimeoutMs = positiveEnv(SUBAGENT_TIMEOUT_ENV);

export const agentRunner = createAgentRunner({
  store,
  jobs: JOB_REGISTRY,
  // 存储层自己实现发件项的记录端口：运行器只认「记一条」，不认数据库。
  outbox: store,
  ...(subagentLimit === undefined ? {} : { subagentLimit }),
  ...(subagentTimeoutMs === undefined ? {} : { subagentTimeoutMs }),
  buildAgent: async ({
    sessionId,
    session,
    model,
    effort,
    botId,
    projectId,
    subagentFactory,
    jobs,
    steering,
    approvalPolicy,
    notices,
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
      botId,
      projectId,
      store,
      ...(subagentFactory === undefined ? {} : { subagentFactory }),
      jobs,
      steering,
      approvalPolicy,
      ...(notices === undefined ? {} : { notices }),
    });
  },
});

// 任务结算后，完成通知投进拥有者的收件箱；空闲会话会被唤醒。
JOB_REGISTRY.setNoticeAdapter(
  createJobNoticeAdapter({
    registry: JOB_REGISTRY,
    notices: agentRunner.notices,
    store,
  })
);

/**
 * 进程里唯一的那一个扫描循环；`serve.ts` 启动和关停它。
 *
 * 它只把到点的定时器换成收件箱里的待办项，起跑仍然是运行器的事。所以唤醒
 * 走的是运行器的公开入口，而不是另开一条起跑路径（ADR 0012）。
 */
const scanMs = positiveEnv(SCAN_MS_ENV);

export const timerScheduler = createTimerScheduler({
  store,
  wake: (sessionId) => {
    agentRunner.wake(sessionId);
  },
  ...(scanMs === undefined ? {} : { intervalMs: scanMs }),
});
