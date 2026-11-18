import { logger } from "@workspace/shared/logger";
import type { OutboxDelivery } from "@workspace/shared/ws-protocol";

import { outboxChannels } from "./channels";
import { deliveryBody } from "./snippet";
import type { OutboxCandidate, OutboxDeliveries, OutboxStore } from "./types";
import { OUTBOX_EXPIRE_MS, OUTBOX_RACE_MS, OUTBOX_RETENTION_MS } from "./types";

/** 默认扫描间隔：一秒一次。通知的延迟由竞态余量决定，这里快一点没有代价。 */
export const DEFAULT_OUTBOX_SCAN_MS = 1000;

/** 一次扫描最多推几条：一批通知太多时，剩下的下一个周期接着推。 */
const BATCH_LIMIT = 20;

/** 记住「推过」的 id 上限；超过就从最旧的开始丢。 */
const PUSHED_LIMIT = 1024;

export type OutboxDispatcherOptions = {
  store: OutboxStore;
  /** 推给谁、谁在等；测试可以换成一个收集器。 */
  channels?: typeof outboxChannels;
  intervalMs?: number;
  now?: () => number;
  warn?: (message: string, error?: unknown) => void;
};

/** 投递器的只读状态；排障时看它，不用猜。 */
export type OutboxDispatcherState = {
  intervalMs: number;
  /** 有没有连接在等通知。 */
  subscribed: boolean;
  /** 这一轮进程里推出去过多少条。 */
  pushed: number;
  /** 上一次扫描的时刻；一次都没扫过时是 null。 */
  lastScanAt: number | null;
  /** 上一次扫描真的推了几条。 */
  lastSent: number;
  /**
   * 库里还等着几行：送达和过期都没有。
   *
   * 它可能是下一条通知，也可能是没人来取的行——所以要看 `subscribed`：桌面
   * 没连上来时，这个数会一直涨，而那不是故障。
   */
  pending: number;
};

/**
 * 发件箱的投递器。
 *
 * 它只做一件事：把到条件的发件项推给在等的连接，收回执，记账。到条件的三条
 * 判断都写在查询里（会话仍是 `done`、过了竞态余量、不早于连接登记的时刻），
 * 所以这里没有第二套规则。
 *
 * 它不弹通知：能弹的只有桌面进程。推出去之后这一行就不再推第二次——回执丢了
 * 就丢了，比重复弹一条更让人舒服。
 */
export class OutboxDispatcher {
  readonly #store: OutboxStore;
  readonly #channels: typeof outboxChannels;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #warn: (message: string, error?: unknown) => void;

  /** 已经推出去的行；每行只推一次。 */
  readonly #pushed = new Set<string>();

  #handle: ReturnType<typeof setInterval> | undefined;
  #scanning: Promise<void> | undefined;
  #stopped = false;
  #lastScanAt: number | null = null;
  #lastSent = 0;

  constructor(options: OutboxDispatcherOptions) {
    this.#store = options.store;
    this.#channels = options.channels ?? outboxChannels;
    this.#intervalMs = options.intervalMs ?? DEFAULT_OUTBOX_SCAN_MS;
    this.#now = options.now ?? Date.now;
    this.#warn =
      options.warn ??
      ((message, error) => {
        logger.warn(message, error);
      });

    if (!Number.isFinite(this.#intervalMs) || this.#intervalMs <= 0) {
      throw new Error(
        `invalid outbox scan interval: expected a positive finite number of milliseconds, got ${JSON.stringify(this.#intervalMs)}`
      );
    }
  }

  /**
   * 开始投递。
   *
   * 启动时先清掉上一次进程留下的待投行：那些结果已经在会话里，现在弹出来
   * 只会是过时消息。清理失败不拦启动，下一次扫描还会照常跑。
   */
  async start(): Promise<void> {
    if (this.#handle !== undefined) {
      return;
    }

    this.#stopped = false;

    try {
      const expired = await this.#store.expirePendingOutbox(this.#now());

      if (expired > 0) {
        logger.warn(
          `[outbox] expired ${String(expired)} undelivered item(s) from a previous run`
        );
      }
    } catch (error) {
      this.#warn("[outbox] failed to expire the leftovers", error);
    }

    this.#channels.setAckHandler((ids) => {
      void this.#acknowledge(ids);
    });

    this.#handle = setInterval(() => {
      void this.#scan();
    }, this.#intervalMs);
    // 一个扫描循环不该拖住进程退出。
    this.#handle.unref?.();

    void this.#scan();
  }

  /** 停止扫描；正在跑的那次让它跑完。 */
  async stop(): Promise<void> {
    this.#stopped = true;

    if (this.#handle !== undefined) {
      clearInterval(this.#handle);
      this.#handle = undefined;
    }

    await this.#scanning;
  }

  /**
   * 只读状态。
   *
   * `pending` 是库里的数，所以这里是异步的；其余几个字段只说投递器自己活着
   * 没有，读内存就够。
   */
  async state(): Promise<OutboxDispatcherState> {
    return {
      intervalMs: this.#intervalMs,
      lastScanAt: this.#lastScanAt,
      lastSent: this.#lastSent,
      pending: await this.#store.countPendingOutbox(),
      pushed: this.#pushed.size,
      subscribed: this.#channels.subscribedAt() !== null,
    };
  }

  /**
   * 扫一次。
   *
   * 上一次还没扫完时直接返回：慢查询不该叠在一起。失败只记日志——一次库锁
   * 不该让通知永久停摆。
   */
  async #scan(): Promise<void> {
    if (this.#stopped || this.#scanning !== undefined) {
      return;
    }

    const running = this.#sweep();
    this.#scanning = running;

    try {
      await running;
    } finally {
      this.#scanning = undefined;
    }
  }

  async #sweep(): Promise<void> {
    try {
      const now = this.#now();

      await this.#store.expireOutboxBefore({
        deadline: now - OUTBOX_EXPIRE_MS,
        now,
      });
      await this.#store.pruneOutbox(now - OUTBOX_RETENTION_MS);

      this.#lastScanAt = now;
      this.#lastSent = 0;

      // 「从这里起的行才算」由连接自己给出：投递器等到下一次扫描才记下时刻的话，
      // 这两次扫描之间落定的运行会被当成连接之前的历史，永远不投。
      const since = this.#channels.subscribedAt();

      if (since === null) {
        return;
      }

      const candidates = await this.#store.listOutboxCandidates({
        before: now - OUTBOX_RACE_MS,
        limit: BATCH_LIMIT,
        since,
      });

      const items = await this.#collect(candidates);

      if (items.length === 0) {
        return;
      }

      // 先送出去再记账：推送本身抛错时这些行留着下一轮再试，而不是变成
      // 「推过但没送到」。
      this.#channels.send(items);

      for (const item of items) {
        this.#remember(item.id);
      }

      this.#lastSent = items.length;
    } catch (error) {
      this.#warn("[outbox] scan failed", error);
    }
  }

  /** 给候选配上正文；读不出来的行留着下一轮再试，没正文的行直接记过。 */
  async #collect(
    candidates: readonly OutboxCandidate[]
  ): Promise<OutboxDeliveries> {
    const items: OutboxDelivery[] = [];

    for (const candidate of candidates) {
      if (this.#pushed.has(candidate.id)) {
        continue;
      }

      let body: string;

      try {
        const record = await this.#store.getTurnRecord(
          candidate.sessionId,
          candidate.turnId
        );

        body = deliveryBody(record?.content);
      } catch (error) {
        // 一条读失败不能连累这一批的其余行，也不能把它记成「推过」。
        this.#warn(`[outbox] failed to read turn ${candidate.turnId}`, error);

        continue;
      }

      if (body === "") {
        // 没有正文的行永远不会变得有正文：记过，等它过期。
        this.#remember(candidate.id);

        continue;
      }

      items.push({
        body,
        id: candidate.id,
        sessionId: candidate.sessionId,
        title: candidate.title,
        turnId: candidate.turnId,
      });
    }

    return items;
  }

  /** 记住一条推过的行；超过上限时丢掉最旧的记账。 */
  #remember(id: string): void {
    this.#pushed.add(id);

    if (this.#pushed.size <= PUSHED_LIMIT) {
      return;
    }

    const [oldest] = this.#pushed;

    if (oldest !== undefined) {
      this.#pushed.delete(oldest);
    }
  }

  /** 桌面说弹完了：盖章。 */
  async #acknowledge(ids: readonly string[]): Promise<void> {
    try {
      await this.#store.markOutboxDelivered(ids, this.#now());
    } catch (error) {
      this.#warn("[outbox] failed to stamp a delivery", error);
    }
  }
}

/** 建一个投递器。 */
export const createOutboxDispatcher = (
  options: OutboxDispatcherOptions
): OutboxDispatcher => new OutboxDispatcher(options);
