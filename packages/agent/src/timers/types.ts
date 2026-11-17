import type { InboxPayload } from "@workspace/agent-client";

/** 每个会话同时挂着的定时器上限；超了工具层拒绝，模型自己先取消一个。 */
export const TIMER_LIMIT_PER_SESSION = 8;

/** 一条还没到点的定时器。到点之后这一行就不存在了。 */
export type Timer = {
  id: string;
  sessionId: string;
  /** 设定它的那次工具调用；同一个调用重试不会排两个。 */
  toolCallId: string;
  /** 模型写下的「为什么要醒」。 */
  note: string;
  /** 到期时刻，毫秒时间戳。 */
  dueAt: number;
  /** 起跑那次运行要用的宿主配置；进程重启之后只有这份快照还在。 */
  payload: InboxPayload;
  createdAt: number;
};

/**
 * 排一个定时器要提供的字段。
 *
 * 会话身份和起跑配置由绑定的视图补上，工具只填 `toolCallId` / `note` /
 * `dueAt`；存储层拿到的是完整的一条。
 */
export type TimerInsert = {
  sessionId: string;
  toolCallId: string;
  note: string;
  dueAt: number;
  payload: InboxPayload;
};

/** 一条已经到点的定时器；它已经变成收件箱里的一行。 */
export type FiredTimer = Timer & {
  /** 这次扫描认定它到点的时刻，不是 `dueAt`。 */
  firedAt: number;
};

/**
 * 定时器的存储面。
 *
 * 和 `RecoveryStore` 一样按需组合，不进 `AgentStore`：只有扫描循环和定时器工具
 * 需要它，别的存储实现不该被迫补这些方法。
 */
export interface TimerStore {
  /**
   * 排一个定时器。
   *
   * `(sessionId, toolCallId)` 冲突时返回已有那条：重试同一步不会排第二个。
   * 会话挂着的定时器达到 {@link TIMER_LIMIT_PER_SESSION} 时抛 `TimerError`
   * （`TIMER_LIMIT_REACHED`），检查和插入在同一个事务里。
   */
  insertTimer(input: TimerInsert): Promise<Timer>;

  /** 按到期时刻列出会话挂着的定时器。 */
  listTimers(sessionId: string): Promise<Timer[]>;

  /** 撤掉一个定时器；返回是否真的删掉了一行。 */
  cancelTimer(sessionId: string, id: string): Promise<boolean>;

  /**
   * 取走全部已到点的定时器：同一个事务里写收件箱行、删定时器行。
   *
   * 调用方拿到结果之后再唤醒会话。在事务里唤醒会让运行器去读还没提交的
   * 收件箱，读到空，那条待办项就躺到下一次用户说话为止。
   */
  fireDueTimers(now: number): Promise<FiredTimer[]>;

  /** 全库挂着的定时器数；扫描循环的状态用。 */
  countTimers(): Promise<number>;
}

/**
 * 绑定到一个会话上的定时器视图。
 *
 * 工具拿到的就是这个：会话身份和起跑配置已经绑好，工具不该知道它们。
 */
export interface SessionTimers {
  /** 排一个定时器；`toolCallId` 用来挡重复。 */
  set(input: {
    toolCallId: string;
    note: string;
    dueAt: number;
  }): Promise<Timer>;
  /** 会话挂着的定时器，按到期时刻排序。 */
  list(): Promise<Timer[]>;
  /** 撤掉一个；返回是否真的删掉了一行。 */
  cancel(id: string): Promise<boolean>;
}

/** 扫描循环的只读状态。 */
export type TimerSchedulerState = {
  /** 扫描间隔，毫秒。 */
  intervalMs: number;
  /** 全库还挂着的定时器数。 */
  pending: number;
  /** 上一次扫描的时刻；一次都没扫过时是 null。 */
  lastScanAt: number | null;
  /** 上一次扫描投出去了几条。 */
  lastFired: number;
};
