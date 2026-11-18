import type { OutboxDeliveries } from "./types";

/** 一条会弹系统通知的连接：推给它，它自己决定怎么弹。 */
export type OutboxPush = (items: OutboxDeliveries) => void;

/** 订阅者 → 登记时刻。时刻由连接自己记下来，投递器不去猜。 */
const pushes = new Map<OutboxPush, number>();
let ackHandler: ((ids: readonly string[]) => void) | undefined;

/**
 * 发件箱的通道注册表。
 *
 * 投递器和应用通道互相不认识：投递器只问「有没有人在等、从什么时候开始等」，
 * 通道在收到订阅时登记一条推送函数、在收到回执时转给投递器。做成模块单例是
 * 因为两边都是进程级的东西；一个进程只有一套连接，没有按会话分的必要。
 */
export const outboxChannels = {
  /** 登记一条会弹通知的连接；返回注销函数。时刻就是这一刻。 */
  add(push: OutboxPush): () => void {
    pushes.set(push, Date.now());

    return () => {
      pushes.delete(push);
    };
  },

  /**
   * 最早一条连接登记的时刻；没有连接时是 null。
   *
   * 拿它当「从这一刻起的行才算」的界，比让投递器等到自己下一次扫描才记下时刻
   * 准：两次扫描之间落定的行不会因此被当成「连接之前的历史」。重连之后从新的
   * 登记时刻算起，更早的行照样不补发。
   */
  subscribedAt(): number | null {
    let earliest: number | null = null;

    for (const at of pushes.values()) {
      earliest = earliest === null ? at : Math.min(earliest, at);
    }

    return earliest;
  },

  /** 推给所有订阅者。 */
  send(items: OutboxDeliveries): void {
    for (const push of pushes.keys()) {
      push(items);
    }
  },

  /** 投递器在这里挂上回执处理。 */
  setAckHandler(handler: (ids: readonly string[]) => void): void {
    ackHandler = handler;
  },

  /** 通道收到回执时调这里。 */
  ack(ids: readonly string[]): void {
    ackHandler?.(ids);
  },
};
