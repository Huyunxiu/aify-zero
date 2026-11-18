import type { OutboxDeliveries } from "./types";

/** 一条会弹系统通知的连接：推给它，它自己决定怎么弹。 */
export type OutboxPush = (items: OutboxDeliveries) => void;

const pushes = new Set<OutboxPush>();
let ackHandler: ((ids: readonly string[]) => void) | undefined;

/**
 * 发件箱的通道注册表。
 *
 * 投递器和应用通道互相不认识：投递器只问「有没有人在等」，通道在收到订阅时
 * 登记一条推送函数、在收到回执时转给投递器。做成模块单例是因为两边都是进程
 * 级的东西；一个进程只有一套连接，没有按会话分的必要。
 */
export const outboxChannels = {
  /** 登记一条会弹通知的连接；返回注销函数。 */
  add(push: OutboxPush): () => void {
    pushes.add(push);

    return () => {
      pushes.delete(push);
    };
  },

  /** 现在有没有人在等通知。没有时投递器什么都不做，行会自然过期。 */
  hasSubscriber(): boolean {
    return pushes.size > 0;
  },

  /** 推给所有订阅者。 */
  send(items: OutboxDeliveries): void {
    for (const push of pushes) {
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
