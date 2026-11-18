import {
  JOB_NOTICE_INBOX_KIND,
  JOB_NOTICE_STEP_SOURCE,
} from "@workspace/agent-client";
import type {
  AgentUserTurn,
  InboxItem,
  SessionCursor,
  SessionStreamEvent,
} from "@workspace/agent-client";
import type { ModelEffort } from "@workspace/shared/constants";
import { getErrorMessage } from "@workspace/shared/errors";
import type { ModelRef } from "@workspace/shared/model";

import type { Agent } from "../agents";
import { resolveDeliverAt } from "../inbox/delivery";
import { InboxItemNotFoundError } from "../inbox/errors";
import type { SteeringSignal } from "../inbox/steering";
import { createSteeringSignal } from "../inbox/steering";
import type { JobRegistry } from "../jobs/registry";
import type { OutboxRecorder } from "../outbox/types";
import { SessionEventRegistry } from "../session-events";
import type { SessionEndStatus } from "../storage";
import { recoverInterruptedRuns } from "../storage/recovery";
import type { RecoveryOutcome } from "../storage/recovery";
import { StreamEventRegistry } from "../stream-registry";
import type { AgentToolSet } from "../types";
import { generateStepId, generateTurnId } from "../utils/id-util";
import { AgentRunnerError } from "./errors";
import { SessionLifecycle } from "./sessions";
import type {
  AgentRunnerLogger,
  AgentRunnerStore,
  BuildAgentInput,
  CreateSessionInput,
  EnqueueInput,
  EnqueueNoticeInput,
  PauseReason,
  ResumeInput,
  StartedRun,
  RunnerStartReport,
  RunnerState,
  RunStart,
} from "./types";

export type AgentRunnerOptions = {
  store: AgentRunnerStore;
  /** 宿主组合：解析设置、建沙箱、装 MCP/skill/context 扩展。 */
  buildAgent: (input: BuildAgentInput) => Promise<Agent>;
  jobs?: JobRegistry;
  /** 运行落定后留一条发件箱记录；宿主不关心通知时可以不给。 */
  outbox?: OutboxRecorder;
  logger?: AgentRunnerLogger;
};

/** 起跑一条待办项的结果。 */
export type StartOutcome = StartedRun | "claimed" | "busy" | "failed";

/** 一条会话自上次用户输入以来，最多被完成通知唤醒几次。 */
const MAX_NOTICE_WAKES = 8;

/**
 * 会话的常驻运行器。
 *
 * 它拥有三件事：会话的推进（从收件箱取一条、起跑、落定后取下一件）、运行的
 * 锁（一个会话同时只有一条运行），以及可重连的会话事件通道。主会话的运行只
 * 由它开始；子会话的运行由创建它的工具调用负责，不走这里。
 *
 * 它是实例，不是进程单例：每个实例有自己的流注册表和事件通道。宿主必须保证
 * 同一个会话只被一个实例处理。
 */
export class AgentRunner {
  readonly #store: AgentRunnerStore;
  readonly #buildAgent: (input: BuildAgentInput) => Promise<Agent>;
  readonly #logger: AgentRunnerLogger;
  readonly #sessionEvents: SessionEventRegistry<AgentToolSet>;
  readonly #streams: StreamEventRegistry<AgentToolSet>;
  readonly #sessions: SessionLifecycle;

  /** 等一次微任务批量处理的会话；不是队列本身，收件箱才是。 */
  readonly #wakeups = new Set<string>();
  /** 每个会话一个插话信号；用户消息插进正在跑的回合时触发。 */
  readonly #steering = new Map<string, SteeringSignal>();
  /** 每个会话最近一次起跑用的模型配置；完成通知靠它唤醒会话。 */
  readonly #lastPayload = new Map<
    string,
    { model: ModelRef; effort?: ModelEffort; projectId?: string }
  >();
  /** 每条会话自上次用户输入以来，被完成通知唤醒过几次。 */
  readonly #noticeWakes = new Map<string, number>();
  /** 正在推进的会话；有值表示这条会话的循环在跑，不是“有一条运行在跑”。 */
  readonly #runs = new Map<string, Promise<void>>();
  /** 不再自动推进的会话，以及原因。不落库。 */
  readonly #paused = new Map<string, PauseReason>();
  #scheduled = false;
  /** 关停中：不再取新件，正在跑的让它跑完。 */
  #stopped = false;

  constructor(options: AgentRunnerOptions) {
    this.#store = options.store;
    this.#buildAgent = options.buildAgent;
    this.#logger = options.logger ?? {
      warn: (message, error) => {
        console.warn(message, error);
      },
    };

    this.#sessionEvents = new SessionEventRegistry<AgentToolSet>();
    this.#streams = new StreamEventRegistry(this.#sessionEvents);
    this.#sessions = new SessionLifecycle({
      store: this.#store,
      registry: this.#streams,
      buildAgent: this.#buildAgent,
      ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
      ...(options.outbox === undefined ? {} : { outbox: options.outbox }),
      steering: (sessionId) => this.steeringSignal(sessionId),
    });
  }

  /**
   * 恢复上一个进程留下的运行，并唤醒还有待办项的会话。
   *
   * 恢复失败不阻塞启动：报告里带着原因，下一次启动会再试。
   */
  async start(): Promise<RunnerStartReport> {
    this.#stopped = false;
    const failures: RunnerStartReport["failures"] = [];

    let recovered: RecoveryOutcome[] = [];
    try {
      recovered = await recoverInterruptedRuns(this.#store);
    } catch (error) {
      failures.push(failureOf(error));
    }

    let pending: string[] = [];
    try {
      pending = await this.#store.listPendingInboxSessionIds();
      pending = await this.#dropStaleNotices(pending);
    } catch (error) {
      failures.push(failureOf(error));
    }

    for (const sessionId of pending) {
      this.#paused.delete(sessionId);
      this.wake(sessionId);
    }

    return { recovered, woken: pending, failures };
  }

  /** 建会话行；已存在时幂等。已删的会话不算「已存在」。 */
  async createSession(input: CreateSessionInput): Promise<void> {
    const existing = await this.#store.findSessionRow(input.sessionId);
    if (existing) {
      // 行还在、但已经删掉：再插一行会撞主键，放它过去又会让一条旧消息把会话
      // 唤醒成一次看不见的运行。当成不存在报出去（ADR 0020）。
      if (existing.deletedAt !== null) {
        throw new AgentRunnerError("SESSION_NOT_FOUND", {
          sessionId: input.sessionId,
        });
      }
      return;
    }

    await this.#store.saveSession({
      id: input.sessionId,
      title: input.title ?? "",
      metadata: input.metadata ?? {},
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });
  }

  /**
   * 删除一个会话。
   *
   * 库里的事归生命周期，内存归这里：删成功之后再把按会话 id 键控的状态清掉。
   * 顺序是先库后内存——库是事实，内存只是它的影子。
   */
  async delete(
    sessionId: string
  ): Promise<{ removed: boolean; sessionIds: string[] }> {
    const result = await this.#sessions.delete(sessionId);
    if (!result.removed) {
      return { removed: false, sessionIds: [] };
    }

    for (const id of result.sessionIds) {
      this.#sessionEvents.forget(id);
      this.#paused.delete(id);
      this.#steering.delete(id);
      this.#lastPayload.delete(id);
      this.#noticeWakes.delete(id);
      this.#wakeups.delete(id);
    }

    return result;
  }

  /** 写一条待办项并唤醒；交付边界由当前流决定。 */
  async enqueue(input: EnqueueInput): Promise<InboxItem> {
    const session = await this.#store.getSessionById(input.sessionId);
    if (!session) {
      throw new AgentRunnerError("SESSION_NOT_FOUND", {
        sessionId: input.sessionId,
      });
    }

    const running = this.#streams.getStreamEntryBySession(input.sessionId);
    const deliverAt = resolveDeliverAt({
      mode: input.mode ?? "followup",
      running: running !== undefined && !running.isDone(),
      streamKind: running?.agent.streamKind,
    });

    const item = await this.#store.insertInboxItem({
      sessionId: input.sessionId,
      kind: "user-message",
      dedupeKey: input.dedupeKey ?? input.turn.id,
      deliverAt,
      content: input.turn,
      payload: {
        model: input.model,
        ...(input.effort === undefined ? {} : { modelEffort: input.effort }),
        ...(input.projectId === undefined
          ? {}
          : { projectId: input.projectId }),
      },
    });

    // 用户自己说话了：唤醒预算重新开始，通知不再按上一条链计数。
    this.#noticeWakes.delete(input.sessionId);
    this.#rememberPayload(input.sessionId, {
      model: input.model,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });

    // 消息能插进正在跑的回合时，等待中的工具先让路；排在下一轮的不用打断。
    if (item.deliverAt === "step-boundary") {
      this.steeringSignal(input.sessionId).notify();
    }

    this.#paused.delete(input.sessionId);
    this.wake(input.sessionId);

    return item;
  }

  /**
   * 记住这个会话最近一次起跑用的模型配置；项目归属没变时沿用上一次的。
   * @param sessionId - 会话 id。
   * @param payload - 本次起跑拿到的配置。
   */
  #rememberPayload(
    sessionId: string,
    payload: { model: ModelRef; effort?: ModelEffort; projectId?: string }
  ): void {
    const projectId =
      payload.projectId ?? this.#lastPayload.get(sessionId)?.projectId;
    this.#lastPayload.set(sessionId, {
      model: payload.model,
      ...(payload.effort === undefined ? {} : { effort: payload.effort }),
      ...(projectId === undefined ? {} : { projectId }),
    });
  }

  /**
   * 这个会话现在能不能收完成通知：有模型配置，且运行器没有在关停。
   * 投递方先用它判断，再决定是否消费任务的未读输出。
   * @param sessionId - 会话 id。
   */
  canDeliverNotice(sessionId: string): boolean {
    return !this.#stopped && this.#lastPayload.has(sessionId);
  }

  /**
   * 投一条完成通知。空闲会话被唤醒，忙的会话排到下一个步边界。
   *
   * 通知不是用户输入：它不重置唤醒预算，也不触发插话信号。连续唤醒超过
   * {@link MAX_NOTICE_WAKES} 次时只排队，等下一次用户输入再交给模型。
   * @param input - 会话、正文与幂等键。
   * @returns 排入的待办项；会话没有可用的模型配置时返回 undefined。
   */
  async enqueueNotice(
    input: EnqueueNoticeInput
  ): Promise<InboxItem | undefined> {
    if (this.#stopped) {
      return undefined;
    }
    const payload = this.#lastPayload.get(input.sessionId);
    if (payload === undefined) {
      this.#logger.warn(
        "[runner] cannot deliver a job notice: the session has no model yet",
        { sessionId: input.sessionId }
      );
      return undefined;
    }

    const running = this.#streams.getStreamEntryBySession(input.sessionId);
    const busy = running !== undefined && !running.isDone();
    const deliverAt = busy ? "step-boundary" : "run-boundary";
    const now = Date.now();
    const turn: AgentUserTurn = {
      id: generateTurnId(),
      type: "user",
      createdAt: now,
      status: "done",
      content: [
        {
          id: generateStepId(),
          type: "user",
          createdAt: now,
          status: "done",
          source: JOB_NOTICE_STEP_SOURCE,
          content: [{ type: "text", text: input.text, createdAt: now }],
        },
      ],
    };

    const item = await this.#store.insertInboxItem({
      sessionId: input.sessionId,
      kind: JOB_NOTICE_INBOX_KIND,
      dedupeKey: input.dedupeKey,
      deliverAt,
      content: turn,
      payload,
    });

    if (!busy) {
      const spent = this.#noticeWakes.get(input.sessionId) ?? 0;
      if (spent < MAX_NOTICE_WAKES) {
        this.#noticeWakes.set(input.sessionId, spent + 1);
        this.wake(input.sessionId);
      }
    }

    return item;
  }

  /** 审批恢复：答复写回 step，再起一次运行。 */
  async resume(input: ResumeInput): Promise<RunStart> {
    this.#paused.delete(input.sessionId);
    this.#rememberPayload(input.sessionId, {
      model: input.model,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
    });

    const result = await this.#sessions.resume({
      sessionId: input.sessionId,
      approvals: input.approvals,
      model: input.model,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
    });

    // 审批恢复的那次运行也要回到循环里，并且按普通运行的规矩收尾：跑完接着
    // 取下一件，失败就暂停。
    if (result.status === "running") {
      void result.settled.then((status) => {
        if (this.#mayTakeNext(input.sessionId, status)) {
          this.wake(input.sessionId);
        }
      });
    }

    return result;
  }

  /**
   * 登记一次唤醒；不阻塞调用方，也不保证马上有运行开始。
   *
   * 它不清暂停：暂停是对自动推进的刹车，只有新消息或用户明确“继续”才解除。
   * 压缩结束、定时器到点这类推进不能替用户做这个决定。
   */
  wake(sessionId: string): void {
    if (this.#stopped) {
      return;
    }

    this.#wakeups.add(sessionId);
    this.#schedule();
  }

  /**
   * 一个会话的插话信号；没有时创建。
   * @param sessionId - 会话 id。
   */
  steeringSignal(sessionId: string): SteeringSignal {
    const existing = this.#steering.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created = createSteeringSignal();
    this.#steering.set(sessionId, created);
    return created;
  }

  /** 清掉暂停并唤醒；用户明确要求继续时用它。 */
  wakeAfterPause(sessionId: string): void {
    this.#paused.delete(sessionId);
    this.wake(sessionId);
  }

  /** 一条会话的长连接；跨运行，读到 `run.end` 不关闭。 */
  subscribe(
    sessionId: string,
    cursor?: SessionCursor
  ): ReadableStream<SessionStreamEvent<AgentToolSet>> {
    return this.#sessionEvents.subscribe(sessionId, cursor);
  }

  /** 只读状态：正在推进的会话、等待中的唤醒、暂停原因。 */
  state(): RunnerState {
    return {
      running: [...this.#runs.keys()],
      waiting: [...this.#wakeups],
      paused: [...this.#paused].map(([sessionId, reason]) => ({
        sessionId,
        reason,
      })),
    };
  }

  /** 停掉会话正在跑的运行；没有运行时也清理残留标记。 */
  async stop(sessionId: string): Promise<{ aborted: boolean }> {
    return await this.#sessions.stop(sessionId);
  }

  /** 空闲会话按需压缩；落定后唤醒队列。 */
  async compact(
    sessionId: string,
    input: { model: ModelRef; effort?: ModelEffort }
  ): Promise<{ activeStreamId: string }> {
    return await this.#sessions.compact({
      sessionId,
      model: input.model,
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      onSettled: () => {
        this.wake(sessionId);
      },
    });
  }

  /** 从一条 branch 复制出一个自包含的新会话。 */
  async fork(
    sessionId: string,
    messageId?: string
  ): Promise<{ sessionId: string }> {
    return await this.#sessions.fork({
      sessionId,
      ...(messageId === undefined ? {} : { messageId }),
    });
  }

  /**
   * 停止取件，正在跑的运行继续跑完。
   *
   * 关停用它：半途掐断一条运行会把 turn 留成 streaming，重启后由恢复收尾。
   */
  async shutdown(): Promise<void> {
    this.#stopped = true;
    this.#wakeups.clear();
    await Promise.allSettled(this.#runs.values());
    this.#runs.clear();
  }

  /**
   * 进程重启后，任务已经不存在，指向它的完成通知也不该再投递。
   * @param sessionIds - 有待办项的会话。
   * @returns 仍有待办项的会话。
   */
  async #dropStaleNotices(sessionIds: readonly string[]): Promise<string[]> {
    const remaining: string[] = [];
    for (const sessionId of sessionIds) {
      try {
        const items = await this.#store.listInboxItems(sessionId);
        const stale = items
          .filter((item) => item.kind === JOB_NOTICE_INBOX_KIND)
          .map((item) => item.id);
        if (stale.length > 0) {
          await this.#store.deleteInboxItems(sessionId, stale);
        }
        if (items.length > stale.length) {
          remaining.push(sessionId);
        }
      } catch (error: unknown) {
        this.#logger.warn(
          "[runner] failed to clean up stale job notices",
          error
        );
        remaining.push(sessionId);
      }
    }
    return remaining;
  }

  #schedule(): void {
    if (this.#scheduled) {
      return;
    }
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#pump();
    });
  }

  /**
   * 把等待中的会话各推进一格。
   *
   * 不设并发上限：每条会话同时只有一条运行，而会话数是人开出来的。真正的
   * 资源边界在沙箱和供应商那里。
   */
  #pump(): void {
    if (this.#stopped) {
      return;
    }

    for (const sessionId of this.#wakeups) {
      this.#wakeups.delete(sessionId);

      if (this.#runs.has(sessionId) || this.#paused.has(sessionId)) {
        continue;
      }

      const run = this.#runSession(sessionId).finally(() => {
        this.#runs.delete(sessionId);
        if (this.#wakeups.size > 0) {
          this.#schedule();
        }
      });
      this.#runs.set(sessionId, run);
    }
  }

  /**
   * 一条会话的循环：取一批、跑完、再看一眼。
   *
   * 只有 `done` 会继续；`error` 和 `canceled` 停下来并记住原因，`wait_review`
   * 直接停——历史里有一条工具调用没有结果，结构上不该推进。
   */
  async #runSession(sessionId: string): Promise<void> {
    for (;;) {
      if (this.#stopped || !(await this.#ready(sessionId))) {
        return;
      }

      // 运行起点不看交付边界：残留的 step-boundary 项也在这一次领走。
      const items = await this.#store.listInboxItems(sessionId);
      if (items.length === 0) {
        return;
      }
      if (items.length > 1) {
        this.#logger.warn(
          `[runner] claiming ${items.length} pending items in one run for ${sessionId}`
        );
      }

      const started = await this.#start(sessionId, items);
      if (started === "claimed") {
        continue;
      }
      if (started === "busy") {
        return;
      }
      if (started === "failed") {
        return;
      }

      if (!this.#mayTakeNext(sessionId, await started.settled)) {
        return;
      }
    }
  }

  /**
   * 一次运行落定之后能不能接着取下一条。
   */
  #mayTakeNext(sessionId: string, status: SessionEndStatus): boolean {
    if (status === "wait_review") {
      return false;
    }

    if (status === "done") {
      return true;
    }

    this.#paused.set(sessionId, status === "canceled" ? "canceled" : "error");
    return false;
  }

  /**
   * 这个会话现在能不能起跑。
   */
  async #ready(sessionId: string): Promise<boolean> {
    if (this.#paused.has(sessionId)) {
      return false;
    }

    const session = await this.#store.getSessionById(sessionId);
    if (!session || session.kind === "subagent") {
      return false;
    }
    if (session.status === "wait_review") {
      return false;
    }

    const entry = this.#streams.getStreamEntryBySession(sessionId);
    return entry === undefined || entry.isDone();
  }

  /**
   * 起跑一批待办项。
   *
   * 起不来时停下这一轮的循环——待办项还在收件箱里，用户看得见，可以取消或
   * 重发。继续转只会用同一个错误反复敲库。
   */
  async #start(
    sessionId: string,
    items: readonly InboxItem[]
  ): Promise<StartOutcome> {
    // 模型配置取这一批里最新的那条：`startFromInbox` 也按它起跑。
    const latest = items.at(-1);
    if (latest !== undefined) {
      this.#rememberPayload(sessionId, {
        model: latest.payload.model,
        ...(typeof latest.payload.modelEffort === "string"
          ? { effort: latest.payload.modelEffort as ModelEffort }
          : {}),
        ...(latest.payload.projectId === undefined
          ? {}
          : { projectId: latest.payload.projectId }),
      });
    }
    try {
      return await this.#sessions.startFromInbox({ sessionId, items });
    } catch (error) {
      if (isClaimedElsewhere(error)) {
        return "claimed";
      }
      if (isBusy(error)) {
        // 压缩在两步之间抢到了锁。待办项还在队列里，等它结束时的唤醒。
        return "busy";
      }

      this.#logger.warn("[runner] failed to start a run", error);
      // 起不来的会话要留下原因，否则 state() 里它既没在跑也没暂停。
      this.#paused.set(sessionId, "error");
      return "failed";
    }
  }
}

export function createAgentRunner(options: AgentRunnerOptions): AgentRunner {
  return new AgentRunner(options);
}

function failureOf(error: unknown): { error: string } {
  return { error: getErrorMessage(error) ?? "unknown error" };
}

/** 会话上已经有一条运行占着锁。 */
function isBusy(error: unknown): boolean {
  return error instanceof AgentRunnerError && error.code === "SESSION_BUSY";
}

/** 这条待办项已经被另一个调用者领走。 */
function isClaimedElsewhere(error: unknown): boolean {
  return error instanceof InboxItemNotFoundError;
}
