import { STREAM_REGISTRY } from "@workspace/agent";
import type {
  InboxItem,
  TextStreamToolApprovalResponseEvent,
} from "@workspace/agent-client";
import type {
  AgentStore,
  SessionEndStatus,
} from "@workspace/agent/storage/index";
import type { ModelEffort } from "@workspace/shared/constants";
import { logger } from "@workspace/shared/logger";

import type { ConfiguredModel } from "../routers/settings/settings.schema";
import { SQLiteStore } from "../storage/sqlite-store";
import { createSessionLifecycle } from "./lifecycle";
import type { CreateSessionResult } from "./lifecycle";

/** 从 store 里读到的、运行器需要的那几件事。 */
export type RunnerStore = Pick<
  AgentStore,
  "getSessionById" | "listInboxMessages"
>;

/** 注册表里运行器需要的那一面：这个会话有没有一条流在跑。 */
export type RunnerRegistry = {
  getStreamEntryBySession(sessionId: string): { isDone(): boolean } | undefined;
};

/** 起跑一次运行；`settled` 在运行落定时给出结束状态。 */
export type StartedRun = { settled: Promise<SessionEndStatus> };

export type StartRun = (input: {
  sessionId: string;
  item: InboxItem;
}) => Promise<StartedRun>;

/** 暂停的原因：结束状态里除了 `done` 的那两个。 */
export type PauseReason = Exclude<SessionEndStatus, "done">;

export type ResumeInput = {
  sessionId: string;
  approvals: TextStreamToolApprovalResponseEvent[];
  configured: ConfiguredModel;
  effort?: ModelEffort;
};

export type ResumeRun = (input: ResumeInput) => Promise<CreateSessionResult>;

export type SessionRunnerOptions = {
  store: RunnerStore;
  registry: RunnerRegistry;
  /** 从一条待办项起跑。 */
  startRun: StartRun;
  /** 审批恢复：写回答复之后再起一次运行。 */
  resumeRun: ResumeRun;
  /** 同时最多几条运行；省略时 4。 */
  maxConcurrent?: number;
  /** 内部告警的落点；测试可以换成收集器。 */
  warn?: (message: string, error?: unknown) => void;
};

const DEFAULT_MAX_CONCURRENT = 4;

/**
 * 一个会话同时只有一条运行，主会话的运行只由它启动。
 *
 * 它只管三件事：拿锁、取件、起跑。投递是流的事，重试不做，取消归注册表。
 *
 * 唤醒是可以丢的：每次运行落定之后循环会再看一眼收件箱，所以少一次唤醒最坏
 * 是晚一轮，不是永远不动。这条是整个设计能承受单点的原因。
 */
export class SessionRunner {
  readonly #store: RunnerStore;
  readonly #registry: RunnerRegistry;
  readonly #startRun: StartRun;
  readonly #resumeRun: ResumeRun;
  readonly #maxConcurrent: number;
  readonly #warn: (message: string, error?: unknown) => void;

  /** 等一次微任务批量处理的会话；不是队列本身，收件箱才是。 */
  readonly #wakeups = new Set<string>();
  /** 正在推进的会话；有值表示这条会话的循环在跑，不是“有一条运行在跑”。 */
  readonly #runs = new Map<string, Promise<void>>();
  /** 不再自动推进的会话，以及原因。不落库。 */
  readonly #paused = new Map<string, PauseReason>();
  #scheduled = false;
  /** 关停中：不再取新件，正在跑的让它跑完。 */
  #stopped = false;

  constructor(options: SessionRunnerOptions) {
    this.#store = options.store;
    this.#registry = options.registry;
    this.#startRun = options.startRun;
    this.#resumeRun = options.resumeRun;
    this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.#warn =
      options.warn ?? ((message, error) => logger.warn(message, error));
  }

  /** 登记一次唤醒；不阻塞调用方，也不保证马上有运行开始。 */
  wake(sessionId: string): void {
    if (this.#stopped) {
      return;
    }
    this.#wakeups.add(sessionId);
    this.#schedule();
  }

  /**
   * 停止取件，正在跑的运行继续跑完。
   *
   * 关停用它：半途掐断一条运行会把 turn 留成 streaming，重启后由恢复收尾；
   * 让它跑完更省事，反正进程还要等 HTTP 连接退干净。
   */
  stop(): void {
    this.#stopped = true;
    this.#wakeups.clear();
  }

  /** 只读状态：正在推进的会话、等待中的唤醒、暂停原因。 */
  state(): {
    running: string[];
    waiting: string[];
    paused: { sessionId: string; reason: PauseReason }[];
  } {
    return {
      running: [...this.#runs.keys()],
      waiting: [...this.#wakeups],
      paused: [...this.#paused].map(([sessionId, reason]) => ({
        sessionId,
        reason,
      })),
    };
  }

  /** 解除暂停并立刻看一眼收件箱：用户投递时用它。 */
  wakeAfterPause(sessionId: string): void {
    this.#paused.delete(sessionId);
    this.wake(sessionId);
  }

  /**
   * 审批恢复。
   *
   * 它不是从收件箱领一条，而是把答复写回对应的 step 再起一次运行；同样经过
   * 这里，主会话的模型回合才只有运行器一个起点。
   */
  async resume(input: ResumeInput): Promise<CreateSessionResult> {
    const { sessionId } = input;
    this.#paused.delete(sessionId);

    const result = await this.#resumeRun(input);

    // 审批恢复的那次运行也要回到循环里，并且按普通运行的规矩收尾：跑完接着
    // 取下一件，失败就暂停。看不到这条运行的结尾，队列就会在失败后继续往下
    // 跑——那正是它该停的时候。
    if (result.status === "running") {
      void result.settled.then((status) => {
        if (this.#decide(sessionId, status)) {
          this.wake(sessionId);
        }
      });
    }

    return result;
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
   * 每条会话的循环自己接着跑，这里只负责在并发上限内把它们放出去；名额满了
   * 就留着，等下一次唤醒。
   */
  #pump(): void {
    if (this.#stopped) {
      return;
    }

    for (const sessionId of this.#wakeups) {
      if (this.#runs.size >= this.#maxConcurrent) {
        return;
      }

      this.#wakeups.delete(sessionId);

      if (this.#runs.has(sessionId) || this.#paused.has(sessionId)) {
        continue;
      }

      const run = this.#runSession(sessionId).finally(() => {
        this.#runs.delete(sessionId);
        // 名额空出来了，或者这一轮结束时还留着等待中的会话：再放一轮。
        if (this.#wakeups.size > 0) {
          this.#schedule();
        }
      });
      this.#runs.set(sessionId, run);
    }
  }

  /**
   * 一条会话的循环：取一条、跑完、再看一眼。
   *
   * 只有 `done` 会继续；`error` 和 `canceled` 停下来并记住原因，`wait_review`
   * 直接停——历史里有一条工具调用没有结果，结构上不该推进，不需要记成暂停。
   */
  async #runSession(sessionId: string): Promise<void> {
    for (;;) {
      if (this.#stopped || !(await this.#ready(sessionId))) {
        return;
      }

      // 运行起点不看交付边界：残留的 step-boundary 项也在这一次领走。
      const [item] = await this.#store.listInboxMessages(sessionId);
      if (!item) {
        return;
      }

      const started = await this.#start(sessionId, item);
      if (started === "claimed") {
        // 这一条已经被别的调用者领走，循环接着取下一条。
        continue;
      }
      if (started === "busy") {
        // 别的运行占着锁：停下这一轮，等它结束后再唤醒。
        return;
      }
      if (started === "failed") {
        return;
      }

      if (!this.#decide(sessionId, await started.settled)) {
        return;
      }
    }
  }

  /**
   * 一次运行落定之后怎么走，返回「循环可以接着取下一条」。
   *
   * `wait_review` 是结构性的等待：历史里有一条没有结果的调用，推进它没有意义，
   * 也不需要记成暂停。`error` / `canceled` 记住原因并停下，免得同一条坏消息
   * 反复触发同一个错误。审批恢复的那次运行和队列里的运行走同一套判断。
   */
  #decide(sessionId: string, status: SessionEndStatus): boolean {
    if (status === "wait_review") {
      return false;
    }

    if (status !== "done") {
      this.#paused.set(sessionId, status);
      return false;
    }

    return true;
  }

  /**
   * 这个会话现在能不能起跑。
   *
   * 子会话的运行归创建它的工具调用，不走这里；等待审批时历史不完整；已经有
   * 一条流在跑（压缩也算）时不抢。
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

    const entry = this.#registry.getStreamEntryBySession(sessionId);
    return entry === undefined || entry.isDone();
  }

  /**
   * 起跑一条待办项。
   *
   * 三种结果：起跑了；这一条已经被别的调用者领走（`"claimed"`）；起不来
   * （`undefined`）。起不来时停下这一轮的循环——待办项还在收件箱里，用户
   * 看得见，可以取消或重发。继续转只会用同一个错误反复敲库。
   */
  async #start(
    sessionId: string,
    item: InboxItem
  ): Promise<StartedRun | "claimed" | "busy" | "failed"> {
    try {
      return await this.#startRun({ sessionId, item });
    } catch (error) {
      if (isClaimedElsewhere(error)) {
        return "claimed";
      }
      if (isBusy(error)) {
        // 压缩在两步之间抢到了锁。待办项还在队列里，等它结束时的唤醒。
        return "busy";
      }

      this.#warn("[runner] failed to start a run", error);
      // 起不来的会话要留下原因，否则 state() 里它既没在跑也没暂停。
      this.#paused.set(sessionId, "error");
      return "failed";
    }
  }
}

/**
 * 默认依赖：真实的 store、注册表和会话生命周期；测试可以逐个覆盖。
 */
export function createSessionRunner(
  overrides: Partial<Omit<SessionRunnerOptions, "store">> & {
    store?: SQLiteStore;
  } = {}
): SessionRunner {
  const store = overrides.store ?? new SQLiteStore();
  const lifecycle = createSessionLifecycle({ store });

  return new SessionRunner({
    store,
    registry: overrides.registry ?? STREAM_REGISTRY,
    startRun:
      overrides.startRun ?? ((input) => lifecycle.startFromInbox(input)),
    resumeRun: overrides.resumeRun ?? ((input) => lifecycle.resume(input)),
    ...(overrides.maxConcurrent === undefined
      ? {}
      : { maxConcurrent: overrides.maxConcurrent }),
    ...(overrides.warn === undefined ? {} : { warn: overrides.warn }),
  });
}

let singleton: SessionRunner | undefined;

/** 进程里唯一的那一个运行器；第一次用到时才建。 */
export function sessionRunner(): SessionRunner {
  singleton ??= createSessionRunner();
  return singleton;
}

/** 会话上已经有一条运行占着锁。 */
function isBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "SESSION_BUSY"
  );
}

/**
 * 这条待办项已经被另一个调用者领走。
 *
 * 以 `code` 判断，不用 `instanceof`：错误可能跨包边界，类身份不保证相同。
 */
function isClaimedElsewhere(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "InboxItemNotFoundError"
  );
}
