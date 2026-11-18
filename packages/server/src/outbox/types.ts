import type { TurnRecord } from "@workspace/agent/store";
import type { OutboxDelivery } from "@workspace/shared/ws-protocol";

/**
 * 落定到投递之间的竞态余量。
 *
 * 运行先把会话写成 `done` 才算落定，而正看着这个会话的页面要等收到 `run.end`
 * 才标记已读。这中间的几百毫秒里，`done` 说的是「刚跑完」而不是「没人看」。等
 * 两个扫描周期再复查一次，最常见的误投就没了。
 *
 * 它不是产品上的静默窗口：没有任何东西被延迟到用户能感知的量级。
 */
export const OUTBOX_RACE_MS = 2000;

/** 等这么久的回执还没来，就不再投了：一条过时的通知比没有通知更烦人。 */
export const OUTBOX_EXPIRE_MS = 10 * 60 * 1000;

/** 送达和过期的行留这么久的账，之后删掉。 */
export const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 一条待投的发件项；正文由投递器按回合现取，不随行存。 */
export type OutboxCandidate = {
  id: string;
  sessionId: string;
  turnId: string;
  /** 会话标题；投递出去的通知用它当标题。 */
  title: string;
};

/** 投递器要的存储面；和 `TimerStore` 一样按需组合，不进 `AgentStore`。 */
export interface OutboxStore {
  /** 取一批可以投的发件项，条件见实现。 */
  listOutboxCandidates(input: {
    since: number;
    before: number;
    limit: number;
  }): Promise<OutboxCandidate[]>;
  /** 盖回执；返回真的改了几行。 */
  markOutboxDelivered(ids: readonly string[], at: number): Promise<number>;
  /**
   * 把等太久还没回执的行标成过期。
   *
   * `deadline` 是「早于这个时刻到达的算过时」，`now` 是「这一刻决定不再投」。
   * 两个时刻不能合并：写进 `expired_at` 的必须是后者。
   */
  expireOutboxBefore(input: { deadline: number; now: number }): Promise<number>;
  /** 启动时清掉上一次进程留下的待投行。 */
  expirePendingOutbox(at: number): Promise<number>;
  /** 删掉超过保留期的行。 */
  pruneOutbox(deadline: number): Promise<number>;
  /**
   * 还没送达、也没过期的行数。
   *
   * 只给只读状态用，不参与投递判断——能不能投写在 `listOutboxCandidates` 的
   * 查询里。它答的是另一个问题：库里还有没有东西在等人来取。
   */
  countPendingOutbox(): Promise<number>;
  /** 读一个回合连同它的 step；投递的正文从这里取，解不出正文就不投。 */
  getTurnRecord(sessionId: string, turnId: string): Promise<TurnRecord | null>;
}

/** 要推送的一批投递。 */
export type OutboxDeliveries = readonly OutboxDelivery[];
