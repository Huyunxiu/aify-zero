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
 * 扫描间隔的环境变量。
 *
 * 没有设置界面：等第二个使用场景出现、知道该按全局还是按会话配置之后再进数据
 * 库，和 `AIFY_SANDBOX_ADAPTER` 同一个做法。今天只有端到端用例读它——它要在一
 * 分钟内看到一次到点，而不是等满两个周期。
 */
const SCAN_MS_ENV = "AIFY_TIMER_SCAN_MS";

/** 环境变量给出的扫描间隔；没设或不是正数时返回 undefined，用调度器的默认值。 */
const timerScanMs = (): number | undefined => {
  const raw = process.env[SCAN_MS_ENV];
  if (raw === undefined || raw === "") {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export const agentRunner = createAgentRunner({
  store,
  jobs: JOB_REGISTRY,
  // 存储层自己实现发件项的记录端口：运行器只认「记一条」，不认数据库。
  outbox: store,
  buildAgent: async ({
    sessionId,
    session,
    model,
    effort,
    projectId,
    streams,
    jobs,
    steering,
    approvalPolicy,
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
      approvalPolicy,
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
const scanMs = timerScanMs();

export const timerScheduler = createTimerScheduler({
  store,
  wake: (sessionId) => {
    agentRunner.wake(sessionId);
  },
  ...(scanMs === undefined ? {} : { intervalMs: scanMs }),
});
